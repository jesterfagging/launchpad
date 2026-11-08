import { showTutorial } from './telegram-tutorial.mjs';
import { RobinhoodTelegram } from './robinhood-telegram.mjs';
import { TelegramConnections } from './telegram-connections.mjs';
import { TelegramExecutionPresets } from './telegram-execution-presets.mjs';
import { TelegramFunding } from './telegram-funding.mjs';
import { appliedExecutionValues } from '../public/execution-presets.mjs';
import { generateWalletBatch } from './wallet-generation.mjs';
import { cleanSniper, sniperRunSettings, sniperFields } from '../public/sniper-settings.mjs';
import { cleanLiquidityPlans, MAX_LP_POSITIONS } from '../public/liquidity-plans.mjs';
import { strategyDefaults } from '../public/strategy-settings.mjs';
import { MAX_WALLETS, WALLET_LIMITS, toolWallets, walletIndices, walletTool } from '../public/wallet-limits.mjs';
import { requireLive } from './live-settings.mjs';
import { cleanRunWallets, runKinds } from '../public/run-settings.mjs';
import { selectedRunSettings } from './run-settings.mjs';
import { runJournalNames } from './run-journals.mjs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { TelegramStore, userId, userKey } from './telegram-store.mjs';
import { TelegramEngine } from './telegram-engine.mjs';
import { tradingIssue } from './run-error-stop.mjs';
import { defaults, fields, parseField, importWallets, importSettings, validateSettings, displayValue, isSecret, redact } from './telegram-settings.mjs';
import { getStrategy, normalizeStrategies, strategyFields, updateStrategy, setWalletBudget, removeWalletBudgets, strategyRunSettings } from './telegram-strategy.mjs';
import { profiles, resolvedStrategy } from '../public/strategy-settings.mjs';
import { short, decimal, SOL, address, units } from './core.mjs';

const groups = { buy: 'Buy settings', sell: 'Sell settings', fees: 'Fees & tips', connections: 'API keys & RPCs', limits: 'Pairs & execution' };
const emptyLedger = { lots: [], pending: [], events: [] };
const stopped = engine => !engine || engine.state === 'stopped';
const tools = { copy: 'Multiwallet / Copy trading', liquidity: 'LP Management', market: 'Market Making', sniper: 'Launch Sniping' };
const copyLike = kind => ['copy', 'sniper'].includes(kind);
const portfolioConnectionFields = new Set(['heliusKey', 'jupiterKey', 'rpcUrl', 'rpcRequestsPerSecond', 'jitoUrl', 'jitoAuth', 'senderUrl']);
const portfolioExecutionFields = new Set(['reserveSol', 'computeUnits']);
const manualActions = new Set(['manual', 'manualSide', 'manualMint', 'manualToken', 'manualWallets', 'manualToggle', 'manualAll', 'manualSize', 'manualPercent', 'manualReview', 'manualConfirm']);

// Read-only upgrade check. Never merges an old journal into a new account.
// The shared web host can use this same helper before a linked account starts.
export async function readLegacyExposure(root, master, telegramId) {
  const id = userId(telegramId), store = new TelegramStore(join(root, 'users', id), userKey(master, id), `user:${id}`);
  const result = { exists: false, openPositions: 0, pending: 0, allocations: 0, unreadable: false, blocked: false };
  try { await stat(store.path('settings')); result.exists = true; } catch (error) { if (error.code !== 'ENOENT') result.exists = result.unreadable = true; }
  for (const name of ['live', 'paper', 'portfolio-live', 'portfolio-paper']) {
    const live = name === 'live' || name === 'portfolio-live';
    try {
      const ledger = await store.read(name);
      if (!ledger) continue;
      result.exists = true;
      if (ledger.version !== 1 || !Array.isArray(ledger.lots) || !Array.isArray(ledger.pending)) throw new Error('Invalid previous ledger.');
      if (live) {
        result.pending += ledger.pending.length;
        if (name === 'live') result.openPositions += ledger.lots.filter(lot => BigInt(lot.remaining) > 0n).length;
        else result.allocations += ledger.lots.length;
      }
    } catch {
      result.exists = true;
      if (live) result.unreadable = true;
    }
  }
  result.blocked = result.unreadable || result.openPositions > 0 || result.pending > 0 || result.allocations > 0;
  return result;
}

const legacyBlockedMessage = 'Previous Telegram positions have not been imported. Resolve the old setup’s open positions, pending transactions and LP allocations in the previous build, or complete an offline migration before starting live trading here.';

export class TelegramBot {
  constructor({ root, master, hostStore, api, outbox, engineFactory = store => new TelegramEngine(store), maxUsers = 100, maxActive = 5, allowedUsers = [], now = Date.now, accounts = null, runtimeManager = null, feePolicy = null, robinhood = null, publicUrl = '' }) {
    Object.assign(this, { root, master, hostStore, api, outbox, engineFactory, maxUsers, maxActive, now, accounts, runtimeManager, feePolicy, publicUrl });
    this.robinhood = robinhood; this.robinhoodMenus = robinhood ? new RobinhoodTelegram(this, robinhood) : null;
    this.connections = accounts && runtimeManager ? new TelegramConnections(this, runtimeManager, robinhood?.runtimes) : null;
    this.executionPresets = new TelegramExecutionPresets(this);
    this.funding = accounts && runtimeManager ? new TelegramFunding(this) : null;
    this.allowed = new Set(allowedUsers.map(userId)); this.users = new Map(); this.loading = new Map(); this.registryQueue = Promise.resolve(); this.closing = false; this.authJobs = 0;
    this.reaper = setInterval(() => this.reap(), 30000); this.reaper.unref();
  }
  async init() { this.registry = await this.hostStore.read('users', []); return this; }
  async context(id) {
    if (this.users.has(id)) return this.users.get(id);
    if (!this.loading.has(id)) {
      const job = this.registryQueue.catch(() => {}).then(async () => {
        if (!this.registry.includes(id)) {
          if (this.registry.length >= this.maxUsers) throw new Error('This bot has reached its user limit. Contact its operator.');
          const next = [...this.registry, id]; await this.hostStore.write('users', next); this.registry = next;
        }
        const store = new TelegramStore(join(this.root, 'users', id), userKey(this.master, id), `user:${id}`);
        // Legacy Telegram keys are never silently copied into a newly linked account.
        const settings = { ...structuredClone(defaults), ...(this.accounts ? {} : await store.read('settings', defaults)) };
        settings.mode = 'live'; settings.strategies = normalizeStrategies(settings.strategies);
        const ctx = { id, store, settings, tool: null, navigation: 0, revision: 0, generation: 0, prompt: null, actions: new Map(), queue: Promise.resolve(), queued: 0, engine: null, startTask: null, closingTask: null, seen: new Set(), notices: [], lastActive: this.now(), rateAt: 0, rate: 0 };
        ctx.preferenceStore = store; ctx.chain = this.robinhood ? (await store.read('chain-selection', 'solana')) : 'solana'; if (!['solana','robinhood'].includes(ctx.chain)) ctx.chain = 'solana';
        ctx.account = null; ctx.authAttempts = []; ctx.settingsStamp = JSON.stringify(settings);
        if (this.accounts) {
          const account = await this.accounts.getTelegramAccount(id);
          if (account) await this.attachAccount(ctx, account);
        }
        this.users.set(id, ctx); return ctx;
      });
      this.registryQueue = job; this.loading.set(id, job); job.finally(() => this.loading.delete(id)).catch(() => {});
    }
    return this.loading.get(id);
  }
  say(ctx, text, buttons, options) { this.outbox.send(ctx.id, redact(text, ctx.settings), buttons, options); }
  button(ctx, text, op, args = {}, ttl = 15 * 60 * 1000) {
    const token = randomBytes(12).toString('hex');
    for (const [id, action] of ctx.actions) if (action.expires < this.now()) ctx.actions.delete(id);
    while (ctx.actions.size >= 240) ctx.actions.delete(ctx.actions.keys().next().value);
    ctx.actions.set(token, { op, args, chain: ctx.chain, tool: ctx.tool, navigation: ctx.navigation, expires: this.now() + ttl });
    return { text, callback_data: token };
  }
  homeButton(ctx) { return this.button(ctx, '‹ Main menu', 'home'); }
  authHome(ctx) {
    ctx.tool = null; ctx.navigation++; ctx.prompt = null;
    const buttons = [[this.button(ctx, 'Create account', 'signup'), this.button(ctx, 'Log in', 'login')], [this.button(ctx, 'Link existing web account', 'link')]];
    if (/^https:\/\//i.test(this.publicUrl)) buttons.unshift([{ text: 'Open Launchpad website', url: this.publicUrl }]);
    this.say(ctx, 'Launchpad\nCreate an account or log in to continue. Your account works across Launchpad web and Telegram.\n\nYou can also sign in on the website and create a one-time Telegram link code under Account.', buttons);
  }
  async attachAccount(ctx, account) {
    if (this.robinhoodMenus && ctx.chain === 'robinhood') return this.robinhoodMenus.attach(ctx, account);
    this.detachEngine(ctx); clearTimeout(ctx.noticeTimer); ctx.noticeTimer = null;
    ctx.account = account; ctx.store = this.accounts.storeFor(account.id);
    const saved = this.runtimeManager?.readSettings ? await this.runtimeManager.readSettings(account.id) : { settings: await ctx.store.read('settings', defaults) };
    ctx.settingsRevision = saved.revision;
    ctx.settings = { ...structuredClone(defaults), ...saved.settings };
    ctx.settings.mode = 'live'; ctx.settings.strategies = normalizeStrategies(ctx.settings.strategies);
    ctx.settingsStamp = JSON.stringify(ctx.settings);
    ctx.actions.clear(); ctx.tool = null; ctx.navigation++; ctx.revision++; ctx.generation++; ctx.prompt = null;
    ctx.seen.clear(); ctx.notices = []; ctx.lastState = null;
    ctx.legacyNoticeShown = false;
    if (this.runtimeManager) this.ensureEngine(ctx);
  }
  detachEngine(ctx) {
    if (ctx.engine && ctx.engineListener) ctx.engine.off('change', ctx.engineListener);
    ctx.engineListener = null; ctx.engine = null;
  }
  async refreshSettings(ctx) {
    if (this.robinhoodMenus && ctx.chain === 'robinhood') return this.robinhoodMenus.refresh(ctx);
    if (!this.accounts || !ctx.account || (!this.runtimeManager && !stopped(ctx.engine)) || ctx.startTask || ctx.closingTask || ctx.engine?.busy) return false;
    const saved = this.runtimeManager?.readSettings ? await this.runtimeManager.readSettings(ctx.account.id) : { settings: await ctx.store.read('settings', defaults) };
    const latest = { ...structuredClone(defaults), ...saved.settings };
    latest.mode = 'live'; latest.strategies = normalizeStrategies(latest.strategies);
    const stamp = JSON.stringify(latest);
    if (stamp === ctx.settingsStamp) { ctx.settingsRevision = saved.revision; return false; }
    ctx.settingsRevision = saved.revision;
    ctx.settings = latest; ctx.settingsStamp = stamp; ctx.revision++; ctx.prompt = null;
    return true;
  }
  async verifyAccountLink(ctx) {
    if (!this.accounts || !ctx.account) return;
    const current = await this.accounts.getTelegramAccount(ctx.id);
    if (current?.id === ctx.account.id) { ctx.account = current; return; }
    this.detachEngine(ctx); clearTimeout(ctx.noticeTimer); ctx.noticeTimer = null; ctx.notices = [];
    ctx.account = null; ctx.settings = structuredClone(defaults); ctx.settingsStamp = JSON.stringify(ctx.settings);
    ctx.actions.clear(); ctx.prompt = null; ctx.tool = null; ctx.navigation++; ctx.generation++; ctx.revision++;
  }
  async authorizedStop(ctx, kind) {
    await this.verifyAccountLink(ctx);
    return this.stop(ctx, kind);
  }
  authPrompt(ctx, kind) {
    if (ctx.account) return this.accountPage(ctx);
    this.editable(ctx);
    ctx.prompt = { kind: 'auth', authKind: kind, stage: kind === 'link' ? 'code' : 'username', revision: ctx.revision, expires: this.now() + 10 * 60 * 1000 };
    return this.say(ctx, kind === 'link' ? 'Send the one-time code from Account → Link Telegram on the Launchpad website.' : `${kind === 'signup' ? 'Create account' : 'Log in'}\nSend your Launchpad username. You will be asked for your password next.`, [[this.homeButton(ctx)]]);
  }
  async authenticateInput(ctx, prompt, value) {
    if (prompt.stage === 'username') {
      if (!(prompt.authKind === 'signup' ? /^[a-zA-Z0-9_]{3,32}$/ : /^[a-zA-Z0-9_][a-zA-Z0-9_-]{2,31}$/).test(value)) throw new Error('Use 3–32 letters, numbers, or underscores for a new username.');
      ctx.prompt = { ...prompt, username: value, stage: 'password' };
      return this.say(ctx, `${prompt.authKind === 'signup' ? 'Create a password (10–128 characters)' : 'Send your password'}. The message is deleted after processing. Telegram bot chats are not end-to-end encrypted; you can use a web link code instead.`, [[this.homeButton(ctx)]]);
    }
    ctx.authAttempts = ctx.authAttempts.filter(at => at > this.now() - 15 * 60 * 1000);
    if (ctx.authAttempts.length >= 5) throw new Error('Too many account attempts. Wait 15 minutes before trying again.');
    if (this.authJobs >= 4) throw new Error('Account sign-in is busy. Try again shortly.');
    ctx.authAttempts.push(this.now());
    const generation = ctx.generation; this.editable(ctx);
    this.authJobs++;
    try {
      let account;
      if (prompt.stage === 'code') account = await this.accounts.get(await this.accounts.redeemLinkCode(value, ctx.id));
      else {
        let password = value, authCode;
        if (prompt.stage === 'password-mfa') {
          const parts = value.split('\n'); authCode = parts.pop()?.trim(); password = parts.join('\n');
          if (!password || !authCode) throw new Error('Send your password on the first line and a new authenticator or recovery code on the second line.');
        }
        try { account = prompt.authKind === 'signup'
          ? await this.accounts.register(prompt.username, value, { maxUsers: this.maxUsers })
          : await this.accounts.authenticate(prompt.username, password, authCode);
        } catch (error) {
          if (error.mfaRequired) {
            ctx.prompt = { ...prompt, stage: 'password-mfa' };
            return this.say(ctx, 'Two-factor authentication is enabled. Send your password on the first line and a new authenticator or recovery code on the second line, in one message. You can also link from the Launchpad website instead.', [[this.homeButton(ctx)]]);
          }
          throw error;
        }
        if (generation !== ctx.generation || prompt !== ctx.prompt) return;
        const { code } = await this.accounts.createLinkCode(account.id);
        if (generation !== ctx.generation || prompt !== ctx.prompt) return;
        account = await this.accounts.get(await this.accounts.redeemLinkCode(code, ctx.id));
      }
      if (generation !== ctx.generation || prompt !== ctx.prompt) {
        if (this.accounts.unlinkTelegram) await this.accounts.unlinkTelegram(ctx.id, account.id);
        return;
      }
      await this.attachAccount(ctx, account);
      this.say(ctx, `Signed in as ${account.username}. Your main wallet is available under Account. Your Copy, LP and MM default wallets are ready in their menus.`);
      return this.modes(ctx);
    } finally {
      this.authJobs--;
    }
  }
  async accountPage(ctx) {
    if (this.robinhoodMenus && ctx.chain === 'robinhood' && ctx.account) return this.robinhoodMenus.account(ctx);
    if (!ctx.account) return this.authHome(ctx);
    ctx.prompt = null; ctx.account = await this.accounts.get(ctx.account.id);
    this.say(ctx, `Account: ${ctx.account.username}\n\nCashback wallet\n${ctx.account.cashbackWallet||ctx.account.mainWallet}\n\nCashback: ${ctx.account.cashbackBps / 100}% of eligible Launchpad platform fees.\nThis wallet is not automatically used for trading.`, [...(this.connections ? [[this.button(ctx, 'Connections · RPCs & API keys', 'accountConnections')]] : []), [this.button(ctx, 'Log out', 'logout')], [this.homeButton(ctx)]]);
  }
  async platformFee(ctx) {
    if (!this.feePolicy || !ctx.account) return { version: undefined, text: '' };
    const policy = await this.feePolicy(ctx.account.id);
    return { version: policy.version, text: `\n\nPlatform fees\n${[policy.description, policy.liquidityDescription].filter(Boolean).join('\n')}\nCashback: ${(policy.cashbackBps ?? ctx.account.cashbackBps) / 100}% of eligible Launchpad platform fees, accrued for your selected cashback wallet. Network fees, tips and pool fees are separate. Pressing Start or Confirm accepts the displayed fees.` };
  }
  async legacyCheck(ctx, enforce = false) {
    if (!this.accounts || !ctx.account) return '';
    const result = await readLegacyExposure(this.root, this.master, ctx.id);
    if (enforce && result.blocked) throw new Error(legacyBlockedMessage);
    if (!result.exists || ctx.legacyNoticeShown) return '';
    ctx.legacyNoticeShown = true;
    return `\n\nPrevious Telegram data found: settings and position history have not been imported into this account. ${result.blocked ? result.unreadable ? 'An old live journal could not be read. Restore it before live trading; do not discard it.' : `${result.openPositions} open copied positions, ${result.pending} pending transactions, ${result.allocations} LP/strategy allocations remain. ${legacyBlockedMessage}` : 'Your old data is preserved. Import a saved setup JSON if needed; this does not import old positions.'}`;
  }
  async logout(ctx) {
    this.editable(ctx);
    if (!stopped(ctx.engine)) throw new Error('Stop all runs before unlinking this Telegram account.');
    if (this.robinhoodMenus && ctx.account && (!stopped(this.robinhoodMenus.manager.get(ctx.account.id)) || this.runtimeManager && !stopped(this.runtimeManager.get(ctx.account.id)))) throw new Error('Stop all runs on both chains before unlinking this Telegram account.');
    if (!this.accounts.unlinkTelegram) throw new Error('Account unlinking is not available on this host.');
    await this.accounts.unlinkTelegram(ctx.id, ctx.account.id);
    this.detachEngine(ctx); clearTimeout(ctx.noticeTimer); ctx.noticeTimer = null; ctx.notices = [];
    ctx.account = null; ctx.settings = structuredClone(defaults); ctx.settingsStamp = JSON.stringify(ctx.settings);
    ctx.actions.clear(); ctx.seen.clear(); ctx.generation++; ctx.revision++; return this.authHome(ctx);
  }
  modeStatus(ctx, kind = ctx.tool || 'copy') { return ctx.engine?.status(this.runtimeManager ? kind : undefined) || { state: 'stopped', kind, mode: ctx.settings.mode }; }
  modeStopped(ctx) { return this.modeStatus(ctx).state === 'stopped'; }
  runSettings(ctx) { requireLive(ctx.settings); return this.runtimeManager ? selectedRunSettings(ctx.settings, ctx.tool) : ctx.settings; }
  selectedCount(ctx) { const kind = ctx.tool || 'copy', keys = cleanRunWallets(ctx.settings.runWallets)[kind], wallets = toolWallets(ctx.settings, kind); return keys === null ? wallets.length : wallets.filter(w => keys.includes(w.publicKey)).length; }
  toolSettings(ctx) { return ctx.tool === 'sniper' ? sniperRunSettings(ctx.settings) : ctx.settings; }
  setToolField(next, kind, key, value) {
    const parsed = parseField(key, value);
    if (kind === 'sniper' && (key === 'leads' || sniperFields.includes(key))) next.sniper = cleanSniper({ ...next.sniper, [key === 'leads' ? 'developers' : key]: parsed });
    else next[key] = parsed;
    return next;
  }
  strategy(ctx) {
    if (ctx.tool === 'liquidity' && !ctx.settings.liquidityPlans?.some(p => p.id === ctx.lpEditId)) ctx.lpEditId = ctx.settings.liquidityPlans?.[0]?.id;
    const plan = ctx.tool === 'liquidity' && (ctx.settings.liquidityPlans || []).find(p => p.id === ctx.lpEditId);
    return plan?.strategy || getStrategy(ctx.settings, ctx.tool);
  }
  updateToolStrategy(ctx, key, value) {
    const raw = structuredClone(ctx.settings), plan = ctx.tool === 'liquidity' && (raw.liquidityPlans || []).find(p => p.id === ctx.lpEditId);
    if (plan) raw.strategies.liquidity = plan.strategy;
    const next = updateStrategy(raw, ctx.tool, key, value);
    if (plan) next.liquidityPlans.find(p => p.id === plan.id).strategy = next.strategies.liquidity;
    return next;
  }
  lpSetups(ctx) {
    if (ctx.tool !== 'liquidity') throw Error('Open LP management first.');
    const plans = ctx.settings.liquidityPlans || [];
    this.say(ctx, `LP setups · ${plans.length}/${MAX_LP_POSITIONS}\nEach position has its own budget and preset. Several positions can share one LP wallet. Choose a setup to edit; use Positions to withdraw or release live allocations.`, [
      ...plans.map(p => [this.button(ctx, `${ctx.lpEditId === p.id ? '☑ ' : ''}${p.label} · ${p.strategy.budgetSol} SOL · ${short(p.wallet)}`, 'lpChoose', { id: p.id })]),
      [this.button(ctx, '+ Add LP position', 'lpAdd', { revision: ctx.revision })], [this.homeButton(ctx)] ]);
  }
  async lpAction(ctx, op, args) {
    this.editable(ctx); if (ctx.tool !== 'liquidity') throw Error('Open LP management first.');
    if (op === 'lpSetups') return this.lpSetups(ctx);
    if (op === 'lpChoose') { if (!ctx.settings.liquidityPlans?.some(p => p.id === args.id)) throw Error('LP setup changed.'); ctx.lpEditId = args.id; return this.home(ctx); }
    if (args.revision !== ctx.revision) throw Error('LP settings changed. Open the position setup again.');
    if (op !== 'lpAdd' && args.id !== ctx.lpEditId) throw Error('The selected LP setup changed. Open it again.');
    const next = structuredClone(ctx.settings); next.liquidityPlans = cleanLiquidityPlans(next.liquidityPlans);
    if (op === 'lpAdd') {
      const wallet = toolWallets(next, 'liquidity')[0]; if (!wallet) throw Error('Generate or import an LP wallet first.');
      if (next.liquidityPlans.length >= MAX_LP_POSITIONS) throw Error('Maximum 20 managed LP positions.');
      const id = randomUUID(); next.liquidityPlans.push({ id, label: `LP position ${next.liquidityPlans.length + 1}`, wallet: wallet.publicKey, strategy: next.liquidityPlans.length ? strategyDefaults() : getStrategy(next, 'liquidity') });
      await this.save(ctx, next); ctx.lpEditId = id; return this.home(ctx);
    }
    const plan = next.liquidityPlans.find(p => p.id === ctx.lpEditId); if (!plan) throw Error('Choose an LP setup first.');
    if (op === 'lpRemove') { next.liquidityPlans = next.liquidityPlans.filter(p => p.id !== plan.id); await this.save(ctx, next); ctx.lpEditId = next.liquidityPlans[0]?.id; return this.lpSetups(ctx); }
    if (op === 'lpWallet') return this.say(ctx, 'Choose the wallet for this LP position. Its budget is reserved independently of other positions.', toolWallets(next, 'liquidity').map(w => [this.button(ctx, w.label, 'lpSetWallet', { wallet: w.publicKey, id: plan.id, revision: ctx.revision })]));
    if (op === 'lpSetWallet') { if (!toolWallets(next, 'liquidity').some(w => w.publicKey === args.wallet)) throw Error('Choose an LP wallet.'); plan.wallet = args.wallet; await this.save(ctx, next); return this.home(ctx); }
  }
  editable(ctx) { if (!this.modeStopped(ctx) || ctx.startTask || ctx.closingTask || ctx.engine?.busy) throw new Error('Press Stop for this mode and wait for Stopped before changing this setup.'); }
  async save(ctx, next) {
    this.editable(ctx); next = { ...next, mode: 'live' };
    if (this.accounts && !ctx.account) throw new Error('Log in before changing settings.');
    if (await this.refreshSettings(ctx)) throw new Error('Settings changed on another device. Reopen this setting and try again.');
    if (this.runtimeManager?.saveSettings) {
      const saved = await this.runtimeManager.saveSettings(ctx.account.id, next, ctx.settingsRevision);
      next = saved.settings; ctx.settingsRevision = saved.revision;
    } else await ctx.store.write('settings', next);
    ctx.settings = next; ctx.settingsStamp = JSON.stringify(next); ctx.revision++; ctx.prompt = null;
  }
  dispatch(update) {
    if (this.closing) return Promise.resolve();
    const callback = update.callback_query, message = update.message || callback?.message, from = callback?.from || message?.from;
    if (!message || !from || from.is_bot || message.chat?.type !== 'private' || message.chat.id !== from.id
      || message.forward_origin || message.forward_date || message.via_bot || message.business_connection_id || message.sender_chat || callback?.inline_message_id) return Promise.resolve();
    let id; try { id = userId(from.id); } catch { return Promise.resolve(); }
    if (callback) this.api.call('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
    if (this.allowed.size && !this.allowed.has(id)) { this.outbox.send(id, 'This bot is currently limited to invited Telegram user IDs.'); return Promise.resolve(); }
    const cached = this.users.get(id), stopAction = callback && cached?.actions.get(callback.data), commandStop = /^\/(stop|stopall)(?:@\w+)?(?:\s|$)/i.exec(message.text || '');
    const isStop = !!commandStop || ['stop', 'stopAll'].includes(stopAction?.op) && (!this.robinhoodMenus || stopAction.chain === cached?.chain);
    const stopKind = commandStop?.[1]?.toLowerCase() === 'stopall' || stopAction?.op === 'stopAll' ? undefined : stopAction ? stopAction.tool || undefined : cached?.tool || undefined;
    // Stop bypasses user jobs (including slow preset downloads) and outgoing Telegram queues.
    if (cached && isStop) return this.authorizedStop(cached, stopKind).catch(error => this.say(cached, error.message));
    const generation = cached?.generation;
    return this.context(id).then(ctx => {
      ctx.lastActive = this.now();
      if (isStop) return this.authorizedStop(ctx, stopKind);
      if (this.now() - ctx.rateAt > 60000) { ctx.rateAt = this.now(); ctx.rate = 0; }
      if (++ctx.rate > 60 || ctx.queued >= 12) return;
      ++ctx.queued;
      const job = ctx.queue.catch(() => {}).then(async () => {
        if (this.closing) return;
        if (!callback && (!Number.isFinite(message.date) || Math.abs(this.now() - message.date * 1000) > 120000)) {
          if (message.text || message.document) await this.deleteInput(ctx, message, true);
          this.say(ctx, 'That message arrived too late to apply. Reopen the menu and send it again.', [[this.homeButton(ctx)]]); return;
        }
        await this.verifyAccountLink(ctx);
        const settingsChanged = await this.refreshSettings(ctx);
        if (callback) {
          const action = ctx.actions.get(callback.data);
          if (!action || action.expires < this.now()) { this.say(ctx, 'That button expired. Open a fresh menu with /start.'); return; }
          if (this.robinhoodMenus && action.chain !== ctx.chain && !['chains','chooseChain'].includes(action.op)) throw Error('That button belongs to another chain. Open a fresh menu.');
          if (!['select', 'modes', 'stop', 'stopAll', 'chains', 'chooseChain'].includes(action.op) && (action.tool !== ctx.tool || action.navigation !== ctx.navigation)) throw new Error('That button belongs to an earlier menu. Open the selected mode again.');
          if (settingsChanged && !['home', 'select', 'modes', 'account', 'stop', 'stopAll', 'review', 'group', 'wallets', 'positions', 'activity'].includes(action.op)) throw new Error('Settings changed on another device. Reopen this menu before making changes.');
          if (['launch', 'withdraw', 'release', 'manualConfirm'].includes(action.op) && generation !== undefined && generation !== ctx.generation) return;
          if (['launch', 'withdraw', 'release', 'manualConfirm', 'forget', 'removeWallet', 'generateWallets', 'lpAdd', 'lpRemove', 'lpSetWallet', 'rhStart', 'rhManualConfirm', 'rhWithdraw', 'rhClaimFees', 'rhConvert', 'claimFees'].includes(action.op)) ctx.actions.delete(callback.data);
          await this.action(ctx, action.op, action.args);
        } else await this.message(ctx, message);
      }).catch(error => this.say(ctx, error.message, [[this.homeButton(ctx)]])).finally(() => { --ctx.queued; });
      ctx.queue = job; return job;
    }).catch(error => this.outbox.send(id, redact(error.message, defaults)));
  }
  async deleteInput(ctx, message, sensitive = false) {
    try { await this.api.call('deleteMessage', { chat_id: Number(ctx.id), message_id: message.message_id }); }
    catch { if (sensitive) this.say(ctx, 'Telegram did not let me delete your import message. Please delete it from this chat yourself.'); }
  }
  async snapshot(ctx) {
    const kind = ctx.tool || 'copy', current = ctx.engine?.status();
    if (this.runtimeManager?.view && ctx.account) {
      const value = await this.runtimeManager.view(ctx.account.id, kind, copyLike(kind) ? undefined : ctx.settings.mode);
      return { ...value, positions: copyLike(kind) ? value.positions : value.positions.filter(position => position.kind === kind) };
    }
    if (current && (!stopped(ctx.engine) || ctx.startTask) && (current.kind || 'copy') === kind) return { ...current, positions: copyLike(kind) ? current.positions : current.positions.filter(p => p.kind === kind) };
    const ledger = await ctx.store.read(`${kind === 'sniper' ? 'sniper-' : kind === 'copy' ? '' : 'portfolio-'}${ctx.settings.mode}`, emptyLedger);
    const positions = copyLike(kind) ? ledger.lots.filter(l => BigInt(l.remaining) > 0n).map(l => ({ ...l, balance: decimal(l.remaining, l.decimals) }))
      : ledger.lots.filter(l => l.kind === kind).map(l => ({ ...l, balances: Object.entries(l.tokens).map(([mint, amount]) => ({ mint, amount: decimal(amount, l.decimals?.[mint] ?? (mint === SOL ? 9 : 0)) })) }));
    return { state: ctx.closingTask ? 'stopping' : 'stopped', kind, mode: ctx.settings.mode, positions, pending: ledger.pending, events: ledger.events,
      metrics: current?.kind === kind ? current.metrics : {}, startupError: current?.kind === kind ? current.startupError : null };
  }
  chainMenu(ctx) {
    ctx.tool = null; ctx.prompt = null; ctx.manualDraft = null; ctx.navigation++; ctx.actions.clear();
    this.say(ctx, 'Launchpad · Trading workspace\n\nChoose your chain.\nSolana amounts use SOL. Robinhood amounts use ETH.\n\nWallets and runs stay separate by chain. Web and Telegram share your account.', [[this.button(ctx, '◎ Solana', 'chooseChain', { chain: 'solana' }), this.button(ctx, '🪶 Robinhood', 'chooseChain', { chain: 'robinhood' })], [this.button(ctx, 'Tutorial · RPCs & API keys', 'tutorial')]]);
  }
  async modes(ctx) {
    if (this.robinhoodMenus && ctx.chain === 'robinhood' && ctx.account) return this.robinhoodMenus.modes(ctx);
    if (this.accounts && !ctx.account) return this.authHome(ctx);
    ctx.tool = null; ctx.navigation++; ctx.prompt = null; ctx.manualDraft = null;
    const running = !stopped(ctx.engine) || ctx.startTask || ctx.closingTask;
    const legacy = await this.legacyCheck(ctx);
    const runs = ctx.engine?.status().runs;
    const summary = runs ? Object.entries(tools).map(([k, label]) => `${label}: ${runs[k]?.state || 'stopped'}`).join('\n') : running ? `${tools[ctx.engine?.status().kind || 'copy']}: ${ctx.engine?.state || 'starting'}.` : 'Stopped';
    this.say(ctx, `Launchpad · Solana\nChoose your trading tool. Amounts use SOL.\n\n${summary}\n\n${this.runtimeManager ? 'Each tool uses its selected wallets. Switching menus leaves active runs running.' : 'Your wallets and connections are shared across your tools.'}${legacy}`, [
      ...Object.entries(tools).map(([kind, label]) => [this.button(ctx, label, 'select', { kind })]),
      ...(this.funding ? [[this.button(ctx,'Funding','funding')]] : []),
      ...(running ? [[this.button(ctx, this.runtimeManager ? '⏹ Stop all' : '⏹ Stop', this.runtimeManager ? 'stopAll' : 'stop')]] : []),
      [this.button(ctx, 'Tutorial · RPCs & API keys', 'tutorial')],
      ...(this.accounts ? [[this.button(ctx, 'Account', 'account')]] : []),
      ...(this.robinhoodMenus ? [[this.button(ctx, 'Change chain', 'chains')]] : []),
    ]);
  }
  async home(ctx, welcome = false) {
    if (this.robinhoodMenus && ctx.chain === 'robinhood' && ctx.account) return this.robinhoodMenus.home(ctx);
    if (this.accounts && !ctx.account) return this.authHome(ctx);
    if (!ctx.tool) return this.modes(ctx);
    if (!copyLike(ctx.tool)) return this.portfolioHome(ctx);
    ctx.prompt = null; ctx.manualDraft = null;
    const status = await this.snapshot(ctx), settings = this.toolSettings(ctx);
    const state = status.state === 'running' ? '🟢 Running' : status.state === 'stopped' ? '⚪ Stopped' : status.state === 'starting' ? '🟡 Starting' : '🟡 Stopping';
    const leads = settings.leads.split(/\s+/).filter(Boolean).length;
    const lines = [`Launchpad · ${tools[ctx.tool]}`, '', `${state} · ${(status.state === 'stopped' ? settings.mode : status.mode).toUpperCase()}`, `${this.selectedCount(ctx)}/${toolWallets(settings, ctx.tool).length} selected wallets · ${leads} ${ctx.tool === 'sniper' ? 'developers' : 'targets'}`,
      `Buy: ${settings.amountMode === 'random' ? `${settings.randomMin}–${settings.randomMax}` : settings.amountMode === 'custom' ? 'per-wallet amounts' : settings.buyAmount} ${settings.funding === 'sol' ? 'SOL' : 'lead quote token'}`,
      `Sell: ${settings.sellMode}`, `Fees in SOL: priority ${settings.prioritySol} · Jito ${settings.jitoSol} · Helius ${settings.heliusSol}`, `${status.positions.length} open positions · ${status.pending.length} pending transactions`];
    if (status.metrics.detectionToSendMs != null) lines.push(`Last detected signal → broadcast: ${status.metrics.detectionToSendMs} ms`);
    if (welcome && !settings.wallets.length) lines.push('', 'Choose your wallets and target addresses, then set amounts and fees. Connections are under Account. Settings save automatically. The host runs trades while your phone is offline.');
    const running = !this.modeStopped(ctx) || ctx.startTask || ctx.closingTask;
    if (!this.runtimeManager && running && ctx.engine?.status().kind && ctx.engine.status().kind !== 'copy') lines.push(`${tools[ctx.engine.status().kind]} is active. Stop it before starting copytrading.`);
    this.say(ctx, lines.join('\n'), [
      [this.button(ctx, running ? '⏹ Stop' : `▶ Start ${settings.mode}`, running ? 'stop' : 'review'), this.button(ctx, '↻ Status', 'home')],
      [this.button(ctx, 'Wallets', 'wallets'), this.button(ctx, ctx.tool === 'sniper' ? 'Developer wallets (100 max)' : 'Target addresses', 'field', { key: 'leads' })],
      [this.button(ctx, 'Buy', 'group', { group: 'buy' }), this.button(ctx, 'Sell', 'group', { group: 'sell' }), this.button(ctx, 'Fees', 'group', { group: 'fees' })],
      [this.button(ctx, 'Pairs & limits', 'group', { group: 'limits' }), this.connections ? this.button(ctx, 'Account', 'account') : this.button(ctx, 'Connections', 'group', { group: 'connections' })],
      [this.button(ctx, 'Positions', 'positions'), this.button(ctx, 'Activity', 'activity')],
      [this.button(ctx, 'Manual buy/sell', 'manual')],
      [this.button(ctx, 'Import full setup JSON', 'preset'), this.button(ctx, 'Forget credentials', 'forgetReview')],
      [this.button(ctx, '‹ Modes', 'modes')],
    ]);
  }
  group(ctx, group, page = 0) {
    ctx.prompt = null;
    if (group !== 'execution' && !groups[group]) throw new Error('Unknown settings page.');
    const entries = Object.entries(fields).filter(([key, f]) => (group === 'execution' ? portfolioExecutionFields.has(key) : f.group === group) && this.fieldAllowed(ctx, key)), pages = Math.ceil(entries.length / 8);
    if (!entries.length) throw new Error('These controls are not used in this mode. Use its main menu.');
    page = Math.min(Math.max(0, page), pages - 1);
    const buttons = entries.slice(page * 8, page * 8 + 8).map(([key, f]) => [this.button(ctx, `${f.label}: ${displayValue(key, this.toolSettings(ctx))}`, 'field', { key })]);
    if (group === 'fees') buttons.unshift([this.button(ctx, 'Gas & fee presets · P1 / P2 / P3', 'executionPresets')]);
    if (group === 'buy' && copyLike(ctx.tool)) buttons.push([this.button(ctx, 'Set amounts for individual wallets', 'wallets')]);
    if (pages > 1) buttons.push([...(page > 0 ? [this.button(ctx, '‹ Previous', 'group', { group, page: page - 1 })] : []), ...(page + 1 < pages ? [this.button(ctx, 'Next ›', 'group', { group, page: page + 1 })] : [])]);
    buttons.push([this.homeButton(ctx)]);
    this.say(ctx, `${groups[group] || 'Execution settings'}${pages > 1 ? ` (${page + 1}/${pages})` : ''}\nTap a setting to change it. Changes apply to your next run.`, buttons);
  }
  fieldAllowed(ctx, key) {
    if (key === 'mode' || !Object.hasOwn(fields, key)) return false;
    if (copyLike(ctx.tool)) return true;
    if (!ctx.tool) return false;
    return portfolioConnectionFields.has(key) || (this.strategy(ctx).advanced && (fields[key].group === 'fees' || portfolioExecutionFields.has(key)));
  }
  field(ctx, key) {
    this.editable(ctx); const f = fields[key]; if (!f) throw new Error('Unknown setting.');
    if (!this.fieldAllowed(ctx, key)) throw new Error('Use this mode’s settings menu. Manual fees require Advanced settings.');
    if (f.options || f.type === 'boolean') {
      ctx.prompt = null;
      const values = f.options || ['on', 'off'];
      this.say(ctx, `${f.label}\nCurrent: ${displayValue(key, this.toolSettings(ctx))}${f.help ? `\n${f.help}` : ''}`, [...values.map(value => [this.button(ctx, value, 'set', { key, value })]), [this.homeButton(ctx)]]);
    } else {
      ctx.prompt = { kind: 'field', key, revision: ctx.revision, expires: this.now() + 10 * 60 * 1000 };
      const current = key === 'leads' ? this.toolSettings(ctx).leads || 'Not set' : displayValue(key, this.toolSettings(ctx));
      this.say(ctx, `${f.label}\nCurrent: ${current}\n${f.help || 'Send the new value in your next message.'}${isSecret(key) ? '\nThe import message is deleted after processing. Send - to clear this setting.' : key === 'quoteMints' ? '\nSend - to clear additional quotes.' : ''}\n/cancel returns to the menu.`, [[this.homeButton(ctx)]]);
    }
  }
  async portfolioHome(ctx) {
    ctx.prompt = null;
    const status = await this.snapshot(ctx), s = this.strategy(ctx), limits = resolvedStrategy(s).limits, execution = appliedExecutionValues('solana', ctx.settings);
    const running = !this.modeStopped(ctx) || ctx.startTask || ctx.closingTask;
    const activeKind = this.modeStatus(ctx).kind;
    const lines = [`Launchpad · ${tools[ctx.tool]}`, `${running && activeKind === ctx.tool ? '🟢 ' + status.state : '⚪ Stopped'} · ${(status.state === 'stopped' ? ctx.settings.mode : status.mode).toUpperCase()}`,
      `${this.selectedCount(ctx)}/${toolWallets(ctx.settings, ctx.tool).length} selected trading wallets`, ...(ctx.tool === 'liquidity' ? [`Editing: ${ctx.settings.liquidityPlans?.find(p => p.id === ctx.lpEditId)?.label || 'Default setup'}`] : []), `Token: ${s.baseMint ? short(s.baseMint) : 'Not set'} · Quote: ${s.quoteMint === SOL ? 'SOL' : short(s.quoteMint)}`,
      `Budget: ${s.budgetSol} SOL / ${ctx.tool === 'liquidity' && ctx.lpEditId ? 'position' : 'wallet'}${!ctx.lpEditId && Object.keys(s.walletBudgets).length ? ' · individual overrides saved' : ''}`,
      `${profiles[s.preset].name} · ${limits.deployPercent}% deployed · ${limits.targetPercent}% target token share · ±${limits.bandPercent} points before adjustment`,
      execution ? `Execution preset: ${execution.prioritySol} priority / ${execution.jitoSol} Jito / ${execution.heliusSol} Helius SOL · ${execution.slippagePercent}% slippage` : s.advanced ? `Advanced on · manual fees: ${ctx.settings.prioritySol} priority / ${ctx.settings.jitoSol} Jito / ${ctx.settings.heliusSol} Helius SOL` : 'Automatic fees: 0.00005 SOL priority cap · RPC · no relay tips',
      `${status.positions.length} allocations · ${status.pending.length} pending transactions`, '',
      ctx.tool === 'market' ? 'Rebalances wallet holdings when they drift from your target. Funds stay in the wallets between swaps.' : 'Adds liquidity to supported pools and manages DLMM ranges. Stop leaves LP positions in place; Withdraw returns their tokens.',
    ];
    if (!this.runtimeManager && running && activeKind && activeKind !== ctx.tool) lines.push('', `${tools[activeKind]} is active. Stop it before starting this mode.`);
    this.say(ctx, lines.join('\n'), [
      ...(ctx.tool === 'liquidity' ? [[this.button(ctx, 'LP position setups', 'lpSetups')], ...(ctx.lpEditId ? [[this.button(ctx, 'Position wallet', 'lpWallet', { id: ctx.lpEditId, revision: ctx.revision }), this.button(ctx, 'Remove setup', 'lpRemove', { id: ctx.lpEditId, revision: ctx.revision })]] : [])] : []),
      [this.button(ctx, running ? '⏹ Stop' : `▶ Start ${ctx.settings.mode}`, running ? 'stop' : 'review'), this.button(ctx, '↻ Status', 'home')],
      [this.button(ctx, 'Wallets', 'wallets'), this.button(ctx, 'Pair & budget', 'strategyGroup', { group: 'basic' })],
      [this.button(ctx, 'Presets', 'presets'), this.button(ctx, 'Advanced settings', 'advanced')],
      [this.button(ctx, 'Gas & fee presets · P1 / P2 / P3', 'executionPresets')],
      [this.connections ? this.button(ctx, 'Account', 'account') : this.button(ctx, 'Connections', 'group', { group: 'connections' })],
      [this.button(ctx, 'Positions', 'positions'), this.button(ctx, 'Activity', 'activity')],
      [this.button(ctx, 'Import full setup JSON', 'preset'), this.button(ctx, 'Forget credentials', 'forgetReview')],
      [this.button(ctx, '‹ Modes', 'modes')],
    ]);
  }
  strategyValue(ctx, key) {
    const s = this.strategy(ctx), f = strategyFields[key];
    const value = f.tuning ? resolvedStrategy(s).limits[key] : s[key];
    return typeof value === 'boolean' ? value ? 'On' : 'Off' : value === '' ? 'Not set' : String(value);
  }
  strategyGroup(ctx, group = 'basic', page = 0) {
    ctx.prompt = null;
    const s = this.strategy(ctx);
    if (!['basic', 'tuning', 'pool'].includes(group) || (group !== 'basic' && !s.advanced) || (group === 'pool' && ctx.tool !== 'liquidity')) throw new Error('Choose a settings page from this mode’s menu.');
    const keys = Object.keys(strategyFields).filter(key => group === 'basic' ? ['baseMint', 'quoteMint', 'budgetSol', ...(ctx.tool === 'liquidity' ? ['autoCompoundFees'] : [])].includes(key)
      : group === 'pool' ? ['pool', 'rangeBins', 'maxMoves'].includes(key) : strategyFields[key].tuning && !['rangeBins', 'maxMoves'].includes(key));
    const pages = Math.ceil(keys.length / 7); page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
    const buttons = keys.slice(page * 7, page * 7 + 7).map(key => [this.button(ctx, `${strategyFields[key].label}: ${['baseMint', 'quoteMint', 'pool'].includes(key) && s[key] ? short(s[key]) : this.strategyValue(ctx, key)}`, 'strategyField', { key })]);
    if (pages > 1) buttons.push([...(page ? [this.button(ctx, '‹ Previous', 'strategyGroup', { group, page: page - 1 })] : []), ...(page + 1 < pages ? [this.button(ctx, 'Next ›', 'strategyGroup', { group, page: page + 1 })] : [])]);
    buttons.push([this.homeButton(ctx)]);
    this.say(ctx, `${group === 'basic' ? 'Pair & budget' : group === 'pool' ? 'Pool settings' : 'Allocation & limits'}\n${group === 'basic' ? `Token: ${s.baseMint || 'Not set'}\nQuote: ${s.quoteMint}\nEach wallet uses its own SOL budget, including fees and account rent.` : group === 'pool' ? 'Leave the pool blank for automatic selection. The range uses the pool’s existing bin step.' : 'Custom values apply while Advanced is on. Changing preset resets these overrides.'}`, buttons);
  }
  presets(ctx) {
    ctx.prompt = null; const s = this.strategy(ctx);
    this.say(ctx, `Preset: ${profiles[s.preset].name}\n\n${Object.values(profiles).map(p => `${p.name}: ${p.deployPercent}% deployed, ±${p.bandPercent} points before adjusting. ${p.description}`).join('\n\n')}\n\nChoosing a preset resets custom tuning.`, [
      ...Object.entries(profiles).map(([value, p]) => [this.button(ctx, p.name, 'strategySet', { key: 'preset', value })]), [this.homeButton(ctx)],
    ]);
  }
  advanced(ctx) {
    ctx.prompt = null; const s = this.strategy(ctx);
    this.say(ctx, `Advanced settings: ${s.advanced ? 'On' : 'Off'}\n${s.advanced ? 'Adjust budgets, limits, pool settings and fees. Changes apply to your next run.' : 'The selected preset configures the strategy automatically. Enable Advanced to customize it.'}`, [
      [this.button(ctx, s.advanced ? 'Disable Advanced' : 'Enable Advanced', 'strategySet', { key: 'advanced', value: s.advanced ? 'off' : 'on' })],
      [this.button(ctx, 'Gas & fee presets · P1 / P2 / P3', 'executionPresets')],
      ...(s.advanced ? [[this.button(ctx, 'Per-wallet budgets', 'wallets'), this.button(ctx, 'Fees & tips', 'group', { group: 'fees' })],
        [this.button(ctx, 'Allocation & limits', 'strategyGroup', { group: 'tuning' }), this.button(ctx, 'Execution settings', 'group', { group: 'execution' })],
        ...(ctx.tool === 'liquidity' ? [[this.button(ctx, 'Pool settings', 'strategyGroup', { group: 'pool' })]] : [])] : []),
      [this.homeButton(ctx)],
    ]);
  }
  strategyField(ctx, key) {
    this.editable(ctx); const f = strategyFields[key], s = this.strategy(ctx);
    if (!f || (f.kinds && !f.kinds.includes(ctx.tool)) || (f.advanced && !s.advanced)) throw new Error('Enable Advanced or choose a setting available in this mode.');
    if (key === 'preset') return this.presets(ctx);
    if (key === 'advanced') return this.advanced(ctx);
    ctx.prompt = { kind: 'strategyField', key, tool: ctx.tool, revision: ctx.revision, expires: this.now() + 10 * 60 * 1000 };
    this.say(ctx, `${f.label}\nCurrent: ${this.strategyValue(ctx, key)}\n${f.help || `Send a value from ${f.min} to ${f.max}.`}\n/cancel returns to the menu.`, [[this.homeButton(ctx)]]);
  }
  walletPages(ctx, page, op, extra = {}) {
    const indices = walletIndices(ctx.settings, ctx.tool);
    const pages = Math.max(1, Math.ceil(indices.length / 10));
    page = Math.min(Math.max(0, Number.isInteger(page) ? page : 0), pages - 1);
    const nav = [
      ...(page ? [this.button(ctx, '‹ Previous', op, { ...extra, page: page - 1 })] : []),
      ...(page + 1 < pages ? [this.button(ctx, 'Next ›', op, { ...extra, page: page + 1 })] : []),
    ];
    return { page, pages, indices: indices.slice(page * 10, page * 10 + 10), rows: indices.slice(page * 10, page * 10 + 10).map(i => ctx.settings.wallets[i]), navigation: nav.length ? [nav] : [] };
  }
  wallets(ctx, page = 0) {
    ctx.prompt = null;
    const s = copyLike(ctx.tool) ? null : this.strategy(ctx);
    const view = this.walletPages(ctx, page, 'wallets');
    const lines = view.rows.map((w, n) => { const i = view.indices[n]; return `${i + 1}. ${short(w.publicKey)} · ${w.privateKey ? 'key saved' : 'private key needed'}${s ? ` · budget ${s.walletBudgets[i] || s.budgetSol} SOL` : ctx.settings.amountMode === 'custom' ? ` · amount ${w.amount || 'not set'}` : ''}`; });
    this.say(ctx, `${s ? 'Trading' : 'Follower'} wallets (${toolWallets(ctx.settings, ctx.tool).length}/${WALLET_LIMITS[ctx.tool]}) · Page ${view.page + 1}/${view.pages}\n${lines.join('\n') || 'No wallets saved.'}`, [
      ...(this.runtimeManager ? [[this.button(ctx, 'Choose wallets for this mode', 'runWallets')]] : []),
      [this.button(ctx, 'Import private keys', 'keys'), this.button(ctx, 'Generate wallets', 'generatePrompt')],
      [this.button(ctx, 'Funding addresses', 'walletAddresses'), this.button(ctx, 'Back up wallet keys', 'walletBackup')],
      ...view.rows.map((w, n) => [this.button(ctx, `${view.page * 10 + n + 1}. ${short(w.publicKey)}`, 'wallet', { index: view.indices[n] })]),
      ...view.navigation, [this.homeButton(ctx)],
    ]);
  }
  walletAddresses(ctx, page = 0) {
    ctx.prompt = null;
    const view = this.walletPages(ctx, page, 'walletAddresses');
    this.say(ctx, `Funding addresses · Page ${view.page + 1}/${view.pages}\nNew wallets start empty. Send funds to each address you want to use, including SOL for network fees and tips.\n\n${view.rows.map((w, n) => `${view.page * 10 + n + 1}. ${w.label}\n${w.publicKey}`).join('\n\n') || 'No wallets saved.'}`, [...view.navigation, [this.button(ctx, '‹ Wallets', 'wallets')]]);
  }
  generatePrompt(ctx) {
    this.editable(ctx);
    const remaining = WALLET_LIMITS[ctx.tool] - toolWallets(ctx.settings, ctx.tool).length;
    if (remaining <= 0) throw new Error(`Maximum ${WALLET_LIMITS[ctx.tool]} wallets for this tool already saved.`);
    ctx.prompt = { kind: 'generateWallets', tool: ctx.tool, revision: ctx.revision, expires: this.now() + 10 * 60 * 1000 };
    this.say(ctx, `Generate new wallets\nSend a whole number from 1 to ${remaining}, or choose below. New keys are generated and saved in your account; only public addresses appear in chat. Fund the wallets before trading.`, [
      [1, 5, 10, MAX_WALLETS].filter(n => n <= remaining).map(count => this.button(ctx, `Generate ${count}`, 'generateWallets', { count, revision: ctx.revision })),
      [this.button(ctx, '‹ Wallets', 'wallets')],
    ]);
  }
  async generateWallets(ctx, count) {
    this.editable(ctx);
    const next = structuredClone(ctx.settings), generated = await generateWalletBatch(count, toolWallets(next, ctx.tool), ctx.tool);
    try {
      next.wallets.push(...generated);
      await this.save(ctx, next);
      if (ctx.account) await this.accounts.audit(ctx.account.id, 'trading-wallets-generated');
      this.say(ctx, `${count} wallets generated and saved. They are empty until funded. Use Funding addresses and Back up wallet keys from Wallets.`);
      return this.wallets(ctx, Math.floor((toolWallets(ctx.settings, ctx.tool).length - 1) / 10));
    } finally {
      // Legacy stores retain next as the current settings; shared account saves
      // normalize to a new object. Clear only detached temporary strings.
      for (const w of generated) if (!ctx.settings.wallets.includes(w)) w.privateKey = '';
    }
  }
  async runWallets(ctx, op = 'runWallets', args = {}) {
    if (!this.runtimeManager) return this.wallets(ctx);
    if (op !== 'runWallets') {
      this.editable(ctx);
      if (args.revision !== ctx.revision) throw new Error('Wallet selections changed. Open this menu again.');
      const next = structuredClone(ctx.settings); next.runWallets = cleanRunWallets(next.runWallets);
      if (op === 'runWalletAll') next.runWallets[ctx.tool] = args.all ? null : [];
      else {
        if (!toolWallets(next, ctx.tool).some(w => w.publicKey === args.wallet)) throw new Error('Wallet no longer imported.');
        const selected = next.runWallets[ctx.tool] ?? toolWallets(next, ctx.tool).map(w => w.publicKey);
        next.runWallets[ctx.tool] = selected.includes(args.wallet) ? selected.filter(w => w !== args.wallet) : [...selected, args.wallet];
      }
      await this.save(ctx, next);
    }
    const keys = cleanRunWallets(ctx.settings.runWallets)[ctx.tool], runs = ctx.engine?.status().runs || {};
    const buttons = toolWallets(ctx.settings, ctx.tool).map(w => {
      const used = runKinds.filter(k => k !== ctx.tool && runs[k]?.mode === 'live' && runs[k]?.state !== 'stopped' && runs[k]?.wallets?.includes(w.publicKey));
      return [this.button(ctx, `${keys === null || keys.includes(w.publicKey) ? '☑' : '☐'} ${w.label || short(w.publicKey)}${used.length ? ' · in use' : ''}`, 'runWalletToggle', { wallet: w.publicKey, revision: ctx.revision })];
    });
    buttons.push([this.button(ctx, 'Select all', 'runWalletAll', { all: true, revision: ctx.revision }), this.button(ctx, 'Clear', 'runWalletAll', { all: false, revision: ctx.revision })], [this.button(ctx, '‹ Wallets', 'wallets')], [this.homeButton(ctx)]);
    this.say(ctx, `${tools[ctx.tool]} wallets · ${this.selectedCount(ctx)} selected\nChoose wallets for this mode. Concurrent live modes need separate wallets. Existing positions and pending transactions reserve their wallets until resolved.`, buttons);
  }
  async lockedWallets(ctx) {
    if (this.runtimeManager) await this.runtimeManager.prepare(ctx.account.id);
    const books = await Promise.all((this.runtimeManager ? runJournalNames : ['live', 'paper', 'portfolio-live', 'portfolio-paper']).map(mode => ctx.store.read(mode, emptyLedger)));
    return new Set(books.flatMap((b, i) => [...b.lots.filter(l => l.kind === 'market' || l.kind === 'liquidity' || BigInt(l.remaining || 0) > 0n).map(l => l.wallet), ...b.pending.map(p => p.wallet)]));
  }
  async portfolioPositions(ctx, page = 0) {
    ctx.prompt = null;
    const status = await this.snapshot(ctx), pages = Math.max(1, Math.ceil(status.positions.length / 5));
    page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
    const positions = status.positions.slice(page * 5, page * 5 + 5);
    const lines = positions.map((p, index) => `${page * 5 + index + 1}. ${p.walletLabel || short(p.wallet)} · ${short(p.wallet)}\n${p.paused || (status.pending.some(t => t.wallet === p.wallet) ? 'Transaction pending' : p.position ? `In ${p.position.venue} pool` : 'Funds in wallet')}\n${(p.balances || []).map(b => `${b.mint === SOL ? 'SOL' : short(b.mint)}: ${b.amount}`).join(' · ')}`);
    const buttons = positions.map((p, index) => [this.button(ctx, `${page * 5 + index + 1}. Manage ${short(p.wallet)}`, 'position', { id: p.id, mode: status.mode })]);
    if (pages > 1) buttons.push([...(page ? [this.button(ctx, '‹ Previous', 'positions', { page: page - 1 })] : []), ...(page + 1 < pages ? [this.button(ctx, 'Next ›', 'positions', { page: page + 1 })] : [])]);
    buttons.push([this.homeButton(ctx)]);
    this.say(ctx, `${tools[ctx.tool]} · ${status.mode.toUpperCase()} positions\n\n${lines.join('\n\n') || 'No allocations in this mode.'}\n\n${status.pending.length} pending transactions${pages > 1 ? ` · Page ${page + 1}/${pages}` : ''}`, buttons);
  }
  async portfolioRecord(ctx, args) {
    if (!['market', 'liquidity'].includes(ctx.tool)) throw new Error('The mode changed. Open Positions again.');
    const status = await this.snapshot(ctx), record = status.positions.find(p => p.id === args.id && p.kind === ctx.tool);
    if (!record || args.mode !== status.mode) throw new Error('This allocation changed. Open Positions again.');
    return { status, record };
  }
  async position(ctx, args) {
    ctx.prompt = null;
    const { status, record: r } = await this.portfolioRecord(ctx, args), pending = status.pending.some(p => p.wallet === r.wallet);
    const lines = [`${tools[ctx.tool]} · ${r.walletLabel || 'Wallet'}\n${r.wallet}`, `Token: ${r.baseMint}\nQuote: ${r.quoteMint}`, `Original budget: ${decimal(r.budget, 9)} SOL`,
      r.position ? `Pool: ${r.position.venue}\n${r.position.id}` : 'Allocated assets are in the wallet.',
      ...(r.balances || []).map(b => `${b.mint === SOL ? 'SOL' : b.mint}: ${b.amount}`),
      ...Object.entries(r.poolBalances || {}).map(([mint, amount]) => `Pool ${mint}: ${decimal(amount, r.decimals?.[mint] || 0)}`),
      ...(r.paused ? [r.paused] : []), ...(pending ? ['Transaction pending. Controls return after reconciliation.'] : []),
    ];
    const buttons = pending ? [] : [[this.button(ctx, r.position ? 'Withdraw to wallet' : 'Release allocation', r.position ? 'withdrawReview' : 'releaseReview', args)]];
    if (!pending && r.position && !['PumpSwap', 'Raydium CPMM'].includes(r.position.venue)) buttons.unshift([this.button(ctx, 'Claim fees to wallet', 'claimFeesReview', args)]);
    else if (r.position && ['PumpSwap', 'Raydium CPMM'].includes(r.position.venue)) lines.push('Trading fees already accrue inside the LP reserves.');
    buttons.push([this.button(ctx, '‹ Positions', 'positions')], [this.homeButton(ctx)]);
    return this.say(ctx, lines.join('\n'), buttons);
  }
  async portfolioOperation(ctx, op, args) {
    const requestedAtGeneration = ctx.generation;
    const { status, record: r } = await this.portfolioRecord(ctx, args), claim = op.startsWith('claimFees'), withdrawal = op.startsWith('withdraw') || claim;
    if (requestedAtGeneration !== ctx.generation) return;
    if (ctx.startTask || ctx.closingTask) throw new Error('Wait for the current operation to finish.');
    if (withdrawal ? !r.position : !!r.position) throw new Error('The position changed. Open Positions again.');
    if (status.pending.some(p => p.wallet === r.wallet)) throw new Error('Wait for this wallet’s pending transaction to reconcile.');
    if (!this.modeStopped(ctx) && !(withdrawal && this.modeStatus(ctx).state === 'running' && this.modeStatus(ctx).kind === 'liquidity')) throw new Error('Stop the current run before managing this allocation.');
    if (op.endsWith('Review')) {
      const next = { ...args, revision: ctx.revision, position: JSON.stringify(r.position || null) };
      return this.say(ctx, claim ? `Claim earned fees from ${r.position.venue} to this wallet? The LP position stays open. Normal network fees apply.` : withdrawal ? `Withdraw ${r.position.venue} liquidity for ${short(r.wallet)} back to its wallet?\nThis sends withdrawal transactions in Live mode and leaves the returned assets in the wallet. DLMM can need several confirmed steps.` : `Release the ${short(r.wallet)} allocation?\nThis removes its strategy tracking. It does not sell or transfer any assets.`, [[this.button(ctx, claim ? 'Confirm fee claim' : withdrawal ? 'Confirm withdrawal' : 'Confirm release', claim ? 'claimFees' : withdrawal ? 'withdraw' : 'release', next, 120000)], [this.button(ctx, '‹ Positions', 'positions')]]);
    }
    if (args.revision !== ctx.revision || args.position !== JSON.stringify(r.position || null)) throw new Error('Settings or position changed. Review this operation again.');
    this.checkSlot(ctx); this.ensureEngine(ctx);
    const kind = ctx.tool, generation = ++ctx.generation, raw = strategyRunSettings({ ...ctx.settings, mode: args.mode }, kind);
    ctx.startKind = kind;
    ctx.startTask = Promise.resolve().then(() => {
      if (generation !== ctx.generation) throw new Error('Operation stopped.');
      return claim ? ctx.engine.claimFees({ wallet: r.wallet, id: r.id }, raw) : withdrawal ? ctx.engine.withdraw({ wallet: r.wallet, id: r.id }, raw) : ctx.engine.release(r.id, args.mode, kind);
    }).then(() => {
      if (generation === ctx.generation) this.say(ctx, claim ? 'Fee claim requested. Activity tracks confirmation; the LP position stays open.' : withdrawal ? 'Withdrawal requested. Positions and Activity track confirmation; assets are credited after receipts arrive.' : 'Allocation released. The assets remain in your wallet.', [[this.button(ctx, 'Positions', 'positions')], [this.homeButton(ctx)]]);
    }).catch(error => { if (generation === ctx.generation && !this.notifyRunFailure(ctx, kind)) this.say(ctx, error.message, [[this.homeButton(ctx)]]); }).finally(() => { ctx.startTask = null; ctx.startKind = null; ctx.lastActive = this.now(); });
    this.say(ctx, claim ? 'Preparing the fee claim… You can press Stop during connection setup.' : withdrawal ? 'Preparing withdrawal… You can press Stop during connection setup.' : 'Releasing the allocation…', [[this.button(ctx, '⏹ Stop', 'stop')]]);
  }
  manualContext(ctx) {
    if (!copyLike(ctx.tool)) throw new Error('Open Manual buy/sell from Multiwallet / Copy trading.');
    if (ctx.startTask || ctx.closingTask) throw new Error('Wait for the current operation to finish.');
    const status = this.modeStatus(ctx, ctx.tool), running = status.state !== 'stopped';
    if (running && (status.state !== 'running' || !copyLike(status.kind || 'copy'))) throw new Error('Stop the current operation and wait for Stopped before using Manual buy/sell.');
    const wallets = (running ? status.followers : toolWallets(ctx.settings, ctx.tool)) || [];
    if (!wallets.length) throw new Error('Import follower wallets before using Manual buy/sell.');
    const mode = running ? status.mode : ctx.settings.mode; requireLive({ mode });
    const settings = this.toolSettings(ctx);
    const fees = running ? status.fees : { priority: settings.prioritySol, jito: settings.jitoSol, helius: settings.heliusSol };
    const context = { runId: status?.runId ?? null, running, mode, fees, wallets: wallets.map(w => ({ publicKey: w.publicKey, label: w.label })), platformFees: running ? status.platformFees || null : null };
    return { ...context, stamp: JSON.stringify(context) };
  }
  manualDraft(ctx, args) {
    const draft = ctx.manualDraft;
    if (!draft || draft.id !== args.id || draft.step !== args.step || draft.expires < this.now() || draft.revision !== ctx.revision || draft.generation !== ctx.generation) throw new Error('This manual order changed or expired. Open Manual buy/sell again.');
    if (draft.context.stamp !== this.manualContext(ctx).stamp) throw new Error('The run, wallets or fees changed. Open Manual buy/sell and review again.');
    return draft;
  }
  manualButton(ctx, text, op, extra = {}) {
    const draft = ctx.manualDraft;
    return this.button(ctx, text, op, { id: draft.id, step: draft.step, ...extra }, 120000);
  }
  async manualHome(ctx) {
    const context = this.manualContext(ctx);
    ctx.prompt = null;
    ctx.manualDraft = { id: randomUUID(), step: 0, revision: ctx.revision, generation: ctx.generation, expires: this.now() + 10 * 60 * 1000, context, wallets: [] };
    this.say(ctx, `Manual buy/sell · ${context.mode.toUpperCase()}\nChoose an action, token and wallets, then review before submitting.\n${context.running ? 'Uses the active copytrading run’s fees and connections.' : 'Uses your saved fees and connections. It does not start automatic copytrading.'}\nBuys spend SOL. Sells use each wallet’s tracked Launchpad position and return SOL.`, [[this.manualButton(ctx, 'Buy', 'manualSide', { side: 'buy' }), this.manualButton(ctx, 'Sell', 'manualSide', { side: 'sell' })], [this.homeButton(ctx)]]);
  }
  async manualToken(ctx) {
    const draft = ctx.manualDraft;
    ctx.prompt = { kind: 'manual', field: 'mint', id: draft.id, step: draft.step, tool: ctx.tool, revision: ctx.revision, expires: draft.expires };
    const status = draft.side === 'sell' ? await this.snapshot(ctx) : null;
    if (ctx.manualDraft !== draft || ctx.prompt?.id !== draft.id) return;
    const mints = [...new Set((status?.positions || []).map(p => p.mint))].filter(Boolean);
    this.say(ctx, `Manual ${draft.side} · Token\nSend the token’s Solana mint / contract address.${draft.side === 'sell' ? '\nOr choose an open position below. Only Launchpad-tracked holdings can be sold here.' : ''}`, [...mints.slice(0, 12).map(mint => [this.manualButton(ctx, short(mint), 'manualMint', { mint })]), [this.homeButton(ctx)]]);
  }
  manualWallets(ctx) {
    const draft = ctx.manualDraft; ctx.prompt = null;
    const wallets = draft.context.wallets;
    this.say(ctx, `Manual ${draft.side} · ${draft.context.mode.toUpperCase()}\nToken: ${draft.mint}\nChoose individual wallets or Select all.\n${draft.wallets.length}/${wallets.length} selected`, [
      [this.manualButton(ctx, 'Select all', 'manualAll', { all: true }), this.manualButton(ctx, 'Clear selection', 'manualAll', { all: false })],
      ...wallets.map((w, index) => [this.manualButton(ctx, `${draft.wallets.includes(w.publicKey) ? '☑' : '☐'} ${index + 1}. ${w.label || 'Wallet'} · ${short(w.publicKey)}`, 'manualToggle', { wallet: w.publicKey })]),
      [this.manualButton(ctx, 'Continue', 'manualSize')], [this.homeButton(ctx)],
    ]);
  }
  manualSize(ctx) {
    const draft = ctx.manualDraft;
    if (!draft.wallets.length) throw new Error('Select at least one wallet.');
    ctx.prompt = { kind: 'manual', field: draft.side === 'buy' ? 'amountSol' : 'sellPercent', id: draft.id, step: draft.step, tool: ctx.tool, revision: ctx.revision, expires: draft.expires };
    this.say(ctx, draft.side === 'buy' ? `Send the SOL amount to buy with each of the ${draft.wallets.length} selected wallets.\nExample: .05 means .05 SOL per wallet, plus network fees and tips.` : `Sell what percentage of each selected wallet’s tracked position?\nChoose below or send a number above 0 and up to 100.`, [
      ...(draft.side === 'sell' ? [[10, 25, 50, 100].map(percent => this.manualButton(ctx, `${percent}%`, 'manualPercent', { percent }))] : []),
      [this.manualButton(ctx, '‹ Choose wallets', 'manualWallets')], [this.homeButton(ctx)],
    ]);
  }
  async manualReview(ctx) {
    const draft = ctx.manualDraft, context = draft.context;
    ctx.prompt = null;
    const fee = context.running && context.platformFees
      ? { version: context.platformFees.version, text: `\nPlatform fee: ${(ctx.tool === 'sniper' ? context.platformFees.sniperPpm ?? 10000 : context.platformFees.copyPpm ?? 2500) / 10000}% per buy or sell, collected in SOL (token sells use guaranteed minimum SOL proceeds). Confirming accepts this fee. Network and pool fees are separate.` }
      : context.running ? { version: undefined, text: '' } : await this.platformFee(ctx);
    if (ctx.manualDraft !== draft) return;
    this.manualDraft(ctx, { id: draft.id, step: draft.step });
    draft.feeVersion = fee.version;
    const size = draft.side === 'buy' ? `${draft.amountSol} SOL per wallet · ${decimal(units(draft.amountSol) * BigInt(draft.wallets.length))} SOL total input` : `${draft.sellPercent}% of each selected wallet’s tracked position → SOL`;
    this.say(ctx, `Review manual ${draft.side.toUpperCase()} · ${context.mode.toUpperCase()}\nToken: ${draft.mint}\n${draft.wallets.length} wallets selected\n${draft.wallets.map(w => short(w)).join('\n')}\n\n${size}\nPriority ${context.fees?.priority ?? '0'} · Jito ${context.fees?.jito ?? '0'} · Helius ${context.fees?.helius ?? '0'} SOL per transaction${fee.text}\n\nConfirm submits real transactions for these wallets.`, [
      [this.manualButton(ctx, `Confirm ${context.mode.toUpperCase()} ${draft.side.toUpperCase()}`, 'manualConfirm')],
      [this.manualButton(ctx, '‹ Choose wallets', 'manualWallets')], [this.homeButton(ctx)],
    ]);
  }
  manualResults(ctx, status, draft) {
    const result = status?.manualResult;
    if (result?.id !== draft.id || !Array.isArray(result.outcomes)) {
      this.say(ctx, 'Manual order submitted. Check Positions and Activity for each wallet’s outcome.', [[this.button(ctx, 'Positions', 'positions'), this.button(ctx, 'Activity', 'activity')], [this.homeButton(ctx)]]); return;
    }
    const counts = Object.fromEntries(['confirmed', 'pending', 'failed', 'skipped'].map(state => [state, result.outcomes.filter(o => o.status === state).length]));
    const heading = `Manual ${draft.side} · ${draft.context.mode.toUpperCase()}\n${counts.confirmed} confirmed · ${counts.pending} pending · ${counts.failed} failed · ${counts.skipped} skipped`;
    for (let start = 0; start < result.outcomes.length || !start; start += 10) {
      const lines = result.outcomes.slice(start, start + 10).map(o => `${short(o.wallet)} · ${o.status}${o.error ? `\n${String(o.error).slice(0, 160)}` : ''}${o.signature && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(o.signature) ? `\nSignature: ${o.signature}` : ''}`);
      this.say(ctx, `${heading}\n\n${lines.join('\n\n')}${counts.pending ? '\n\nPending is not confirmed. Wait for reconciliation before retrying that wallet.' : ''}`, [[this.button(ctx, 'Manual buy/sell', 'manual')], [this.button(ctx, 'Positions', 'positions'), this.button(ctx, 'Activity', 'activity')], [this.homeButton(ctx)]]);
    }
  }
  async manualAction(ctx, op, args) {
    if (op === 'manual') return this.manualHome(ctx);
    const draft = this.manualDraft(ctx, args);
    if (op === 'manualConfirm') {
      if (!draft.mint || !draft.wallets.length || (draft.side === 'buy' ? !draft.amountSol : !draft.sellPercent)) throw new Error('Complete and review the manual order first.');
      const requestedGeneration = ctx.generation;
      if (draft.context.mode === 'live') await this.legacyCheck(ctx, true);
      if (requestedGeneration !== ctx.generation) return;
      this.manualDraft(ctx, args); this.checkSlot(ctx); this.ensureEngine(ctx);
      const raw = strategyRunSettings({ ...ctx.settings, mode: draft.context.mode }, ctx.tool);
      if (this.feePolicy) raw.agreedFeeVersion = draft.feeVersion;
      const trade = { id: draft.id, side: draft.side, mint: draft.mint, wallets: [...draft.wallets], expectedRunId: draft.context.runId, ...(draft.side === 'buy' ? { amountSol: draft.amountSol } : { sellPercent: draft.sellPercent }) };
      const generation = ++ctx.generation; ctx.manualDraft = null; ctx.prompt = null; const manualKind = ctx.tool; ctx.startKind = manualKind;
      ctx.startTask = Promise.resolve().then(() => {
        if (generation !== ctx.generation) throw new Error('Operation stopped.');
        return ctx.engine.manualTrade(raw, trade, manualKind);
      }).then(status => { if (generation === ctx.generation && !this.notifyRunFailure(ctx, manualKind)) this.manualResults(ctx, status, draft); })
        .catch(error => { if (generation === ctx.generation && !this.notifyRunFailure(ctx, manualKind)) this.say(ctx, error.message, [[this.homeButton(ctx)]]); })
        .finally(() => { ctx.startTask = null; ctx.startKind = null; ctx.lastActive = this.now(); });
      this.say(ctx, `Preparing manual ${draft.side} for ${draft.wallets.length} wallets… Results will identify confirmed, pending and failed orders.`, [[this.button(ctx, '⏹ Stop', 'stop')]]);
      return;
    }
    if (op === 'manualSide') {
      if (!['buy', 'sell'].includes(args.side)) throw new Error('Choose Buy or Sell.');
      draft.side = args.side; draft.step++; return this.manualToken(ctx);
    }
    if (op === 'manualToken') { draft.step++; return this.manualToken(ctx); }
    if (op === 'manualMint') {
      draft.mint = address(args.mint, 'Token mint');
      if (draft.mint === SOL) throw new Error('Choose the token to buy or sell; SOL is the payment currency.');
      draft.step++; return this.manualWallets(ctx);
    }
    if (op === 'manualToggle') {
      if (!draft.context.wallets.some(w => w.publicKey === args.wallet)) throw new Error('Wallet no longer exists.');
      draft.wallets = draft.wallets.includes(args.wallet) ? draft.wallets.filter(w => w !== args.wallet) : [...draft.wallets, args.wallet];
    }
    if (op === 'manualAll') draft.wallets = args.all ? draft.context.wallets.map(w => w.publicKey) : [];
    if (['manualWallets', 'manualToggle', 'manualAll'].includes(op)) { draft.step++; return this.manualWallets(ctx); }
    if (op === 'manualSize') { if (!draft.wallets.length) throw new Error('Select at least one wallet.'); draft.step++; return this.manualSize(ctx); }
    if (op === 'manualPercent') {
      if (draft.side !== 'sell' || ![25, 50, 100].includes(args.percent)) throw new Error('Choose a valid sell percentage.');
      draft.sellPercent = args.percent; draft.step++; return this.manualReview(ctx);
    }
    if (op === 'manualReview') return this.manualReview(ctx);
  }
  async manualInput(ctx, prompt, value) {
    const draft = this.manualDraft(ctx, prompt);
    if (prompt.field === 'mint') {
      const mint = address(value, 'Token mint');
      if (mint === SOL) throw new Error('Choose the token to buy or sell; SOL is the payment currency.');
      draft.mint = mint; draft.step++; return this.manualWallets(ctx);
    }
    if (prompt.field === 'amountSol') {
      const amount = units(value);
      if (amount <= 0n) throw new Error('Enter a SOL amount greater than zero.');
      draft.amountSol = decimal(amount);
    } else if (prompt.field === 'sellPercent') {
      if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value) || !(Number(value) > 0 && Number(value) <= 100)) throw new Error('Enter a sell percentage above 0 and up to 100, with at most two decimal places.');
      draft.sellPercent = Number(value);
    } else throw new Error('Open Manual buy/sell again.');
    draft.step++; return this.manualReview(ctx);
  }
  async action(ctx, op, args = {}) {
    if (op === 'tutorial') return showTutorial(this, ctx);
    if (this.robinhoodMenus && op === 'chains') return this.chainMenu(ctx);
    if (this.robinhoodMenus && op === 'chooseChain') {
      if (!['solana','robinhood'].includes(args.chain)) throw Error('Choose a supported chain.');
      ctx.chain = args.chain; await ctx.preferenceStore.write('chain-selection', ctx.chain);
      ctx.actions.clear(); ctx.prompt = null; ctx.manualDraft = null; ctx.navigation++; ctx.generation++;
      if (ctx.account) { await this.attachAccount(ctx, ctx.account); return this.modes(ctx); }
      return this.authHome(ctx);
    }
    if (this.accounts) {
      if (['signup', 'login', 'link'].includes(op)) return this.authPrompt(ctx, op);
      if (op === 'account') return this.accountPage(ctx);
      if (!ctx.account) return this.authHome(ctx);
      if (op === 'logout') return this.logout(ctx);
    }
    if (this.connections) {
      if (op === 'accountConnections') return this.connections.menu(ctx, args.chain, args.page);
      if (op === 'connectionField') return this.connections.field(ctx, args);
      if (op === 'connectionSet') return this.connections.save(ctx, args);
      if (op === 'group' && args.group === 'connections') return this.connections.menu(ctx, 'solana');
    }
    if (op.startsWith('execution')) return this.executionPresets.action(ctx, op, args);
    if (this.funding && op.startsWith('funding')) return this.funding.action(ctx,op,args);
    if (this.robinhoodMenus && ctx.chain === 'robinhood') return this.robinhoodMenus.action(ctx, op, args);
    if (op === 'modes') return this.modes(ctx);
    if (op === 'select') {
      if (!Object.hasOwn(tools, args.kind)) throw new Error('Choose a mode from /start.');
      ctx.tool = args.kind; ctx.navigation++; ctx.prompt = null; return this.home(ctx);
    }
    if (op === 'home') return this.home(ctx);
    if (op === 'stopAll') return this.stop(ctx);
    if (op === 'stop') return this.stop(ctx, ctx.tool || undefined);
    if (!ctx.tool) return this.modes(ctx);
    if (op.startsWith('lp')) return this.lpAction(ctx, op, args);
    if (manualActions.has(op)) return this.manualAction(ctx, op, args);
    ctx.manualDraft = null;
    if (op === 'group') {
      if (args.group === 'fees' && this.feePolicy) {
        const fee = await this.platformFee(ctx);
        this.say(ctx, fee.text.trim());
      }
      return this.group(ctx, args.group, args.page);
    }
    if (op === 'field') return this.field(ctx, args.key);
    if (op === 'wallets') return this.wallets(ctx, args.page);
    if (op === 'walletAddresses') return this.walletAddresses(ctx, args.page);
    if (op === 'walletBackup') return this.say(ctx, 'Open the Launchpad website, sign in to this same account, and choose Save full setup. Verify your password and authenticator if enabled. The downloaded backup contains your wallet keys. Keep it private.', [...(/^https:\/\//i.test(this.publicUrl) ? [[{ text: 'Open Launchpad website', url: this.publicUrl }]] : []), [this.button(ctx, '‹ Wallets', 'wallets')]]);
    if (op === 'generatePrompt') return this.generatePrompt(ctx);
    if (op === 'generateWallets') { if (args.revision !== ctx.revision) throw new Error('Settings changed. Open Generate wallets again.'); return this.generateWallets(ctx, args.count); }
    if (['runWallets', 'runWalletToggle', 'runWalletAll'].includes(op)) return this.runWallets(ctx, op, args);
    if (op === 'positions') {
      if (!copyLike(ctx.tool)) return this.portfolioPositions(ctx, args.page);
      const status = await this.snapshot(ctx);
      const rows = status.positions.map(l => `${short(l.wallet)} · ${l.balance}\n${l.mint}`);
      return this.say(ctx, `${status.mode.toUpperCase()} positions\n${rows.slice(0, 25).join('\n\n') || 'No open copied positions.'}${rows.length > 25 ? `\n\nShowing 25 of ${rows.length} positions.` : ''}\n\nPending transactions: ${status.pending.length}`, [[this.homeButton(ctx)]]);
    }
    if (op === 'position') return this.position(ctx, args);
    if (['withdrawReview', 'withdraw', 'releaseReview', 'release', 'claimFeesReview', 'claimFees'].includes(op)) return this.portfolioOperation(ctx, op, args);
    if (op === 'strategyGroup') return this.strategyGroup(ctx, args.group, args.page);
    if (op === 'strategyField') return this.strategyField(ctx, args.key);
    if (op === 'presets') return this.presets(ctx);
    if (op === 'advanced') return this.advanced(ctx);
    if (op === 'activity') {
      const status = await this.snapshot(ctx);
      return this.say(ctx, status.events.slice(0, 10).map(e => `${new Date(e.at).toISOString().slice(11,19)} ${e.level.toUpperCase()}\n${e.message}${e.signature && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(e.signature) ? `\nSignature: ${e.signature}` : ''}`).join('\n\n') || 'No activity yet.', [[this.homeButton(ctx)]]);
    }
    if (op === 'review') return this.review(ctx);
    if (op === 'launch') return this.launch(ctx, args);
    this.editable(ctx);
    if (op === 'strategySet') {
      await this.save(ctx, this.updateToolStrategy(ctx, args.key, args.value));
      return args.key === 'advanced' ? this.advanced(ctx) : this.home(ctx);
    }
    if (op === 'set') {
      if (!this.fieldAllowed(ctx, args.key)) throw new Error('Use this mode’s settings menu.');
      const next = structuredClone(ctx.settings); this.setToolField(next, ctx.tool, args.key, args.value); await this.save(ctx, next);
      return args.key === 'mode' && !copyLike(ctx.tool) ? this.home(ctx) : this.group(ctx, portfolioExecutionFields.has(args.key) && !copyLike(ctx.tool) ? 'execution' : fields[args.key].group);
    }
    if (op === 'paperKeys') throw new Error('Import wallet private keys to trade. Paper setups have been removed.');
    if (['keys', 'preset'].includes(op)) {
      ctx.prompt = { kind: op, tool: ctx.tool, expires: this.now() + 10 * 60 * 1000, revision: ctx.revision };
      return this.say(ctx, op === 'preset' ? 'Send your Launchpad “Save full setup” JSON file, or paste its JSON. It replaces this user’s setup, including both strategy presets. The import message is deleted after processing.' : `Send wallet private keys, one per line (up to ${WALLET_LIMITS[ctx.tool]} for this tool). Base58 keys and JSON byte arrays work; 32-byte seeds need seed: in front.\n\nWallet keys are encrypted and stored on Launchpad’s server for automated signing. Telegram bot chats are not end-to-end encrypted. The import message is deleted after processing.`, [[this.homeButton(ctx)]]);
    }
    if (op === 'wallet') {
      const wallet = ctx.settings.wallets[args.index]; if (!wallet) return this.wallets(ctx);
      if (ctx.tool === 'liquidity' && ctx.settings.liquidityPlans?.length) {
        const plans = ctx.settings.liquidityPlans.filter(p => p.wallet === wallet.publicKey), total = plans.reduce((n, p) => n + units(p.strategy.budgetSol), 0n);
        return this.say(ctx, `${wallet.label}\n${wallet.publicKey}\n${plans.length} LP setups · ${decimal(total)} SOL total planned budget\nEdit budgets separately in LP position setups.`, [[this.button(ctx, 'LP position setups', 'lpSetups')], [this.button(ctx, 'Remove wallet', 'removeWallet', { ...args, publicKey: wallet.publicKey, revision: ctx.revision })], [this.button(ctx, '‹ Wallets', 'wallets')]]);
      }
      if (!copyLike(ctx.tool)) {
        const s = this.strategy(ctx);
        return this.say(ctx, `Wallet ${args.index + 1}\n${wallet.publicKey}\nBudget: ${s.walletBudgets[args.index] || s.budgetSol} SOL${s.walletBudgets[args.index] ? ' (individual override)' : ' (common budget)'}`, [[s.advanced ? this.button(ctx, 'Set wallet budget', 'walletBudget', args) : this.button(ctx, 'Enable Advanced', 'strategySet', { key: 'advanced', value: 'on' })], [this.button(ctx, 'Remove wallet', 'removeWallet', { ...args, publicKey: wallet.publicKey, revision: ctx.revision })], [this.button(ctx, '‹ Wallets', 'wallets')]]);
      }
      return this.say(ctx, `Wallet ${args.index + 1}\n${wallet.publicKey}\nCustom amount: ${wallet.amount || 'not set'} (used only in custom buy mode)`, [[this.button(ctx, 'Set custom buy amount', 'walletAmount', args)], [this.button(ctx, 'Remove wallet', 'removeWallet', { ...args, publicKey: wallet.publicKey, revision: ctx.revision })], [this.button(ctx, '‹ Wallets', 'wallets')]]);
    }
    if (op === 'walletAmount') {
      if (!copyLike(ctx.tool)) throw new Error('Set a wallet budget from this strategy’s menu.');
      const wallet = ctx.settings.wallets[args.index]; if (!wallet) throw new Error('Wallet no longer exists.');
      ctx.prompt = { kind: op, publicKey: wallet.publicKey, revision: ctx.revision, expires: this.now() + 10 * 60 * 1000 };
      return this.say(ctx, `Send the buy amount for ${short(wallet.publicKey)} in the selected buy currency. This will select custom buy mode. Set an amount for every wallet before starting.`, [[this.homeButton(ctx)]]);
    }
    if (op === 'walletBudget') {
      if (ctx.tool === 'liquidity' && ctx.settings.liquidityPlans?.length) throw Error('Edit each position budget in LP position setups.');
      if (copyLike(ctx.tool) || !this.strategy(ctx).advanced) throw new Error('Enable Advanced settings to set individual budgets.');
      const wallet = ctx.settings.wallets[args.index]; if (!wallet) throw new Error('Wallet no longer exists.');
      ctx.prompt = { kind: op, publicKey: wallet.publicKey, tool: ctx.tool, revision: ctx.revision, expires: this.now() + 10 * 60 * 1000 };
      return this.say(ctx, `Send the SOL budget for ${short(wallet.publicKey)}, or - to use the common budget.`, [[this.homeButton(ctx)]]);
    }
    if (op === 'removeWallet') {
      if (args.revision !== ctx.revision || ctx.settings.wallets[args.index]?.publicKey !== args.publicKey) throw new Error('Wallet list changed. Open it again.');
      if ((await this.lockedWallets(ctx)).has(args.publicKey)) throw new Error('This wallet still has positions, portfolio allocations, or pending transactions. Keep it imported until those are resolved.');
      const next = removeWalletBudgets(ctx.settings, args.index); next.wallets.splice(args.index, 1); next.runWallets = cleanRunWallets(next.runWallets); for (const k of runKinds) if (next.runWallets[k]) next.runWallets[k] = next.runWallets[k].filter(key => key !== args.publicKey); await this.save(ctx, next); return this.wallets(ctx);
    }
    if (['forgetReview', 'forget'].includes(op) && !stopped(ctx.engine)) throw new Error('Stop all runs before removing credentials.');
    if (op === 'forgetReview') return this.say(ctx, 'Remove saved private keys, API keys and provider URLs from this user’s setup? Public addresses and transaction history remain. This does not sell or move any holdings.', [[this.button(ctx, 'Remove saved credentials', 'forget', { revision: ctx.revision }, 120000)], [this.homeButton(ctx)]]);
    if (op === 'forget') {
      if (args.revision !== ctx.revision) throw new Error('Settings changed. Open Forget credentials again.');
      const next = structuredClone(ctx.settings);
      for (const key of Object.keys(fields).filter(isSecret)) next[key] = '';
      for (const wallet of next.wallets) wallet.privateKey = '';
      next.mode = 'live'; await this.save(ctx, next);
      if (ctx.engine && !this.runtimeManager) { await ctx.engine.close(); ctx.engine = null; }
      this.say(ctx, 'Saved credentials removed. Wallet assets and LP positions stay in place. Reimport their keys to manage them.'); return this.home(ctx);
    }
  }
  async message(ctx, message) {
    const text = String(message.text || '').trim(), command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (command?.[1] === 'tutorial') return showTutorial(this, ctx);
    if (this.robinhoodMenus && command && ['start','menu','help'].includes(command[1])) return this.chainMenu(ctx);
    if (this.accounts) {
      if (command?.[1] === 'account') return this.accountPage(ctx);
      if (command?.[1] === 'logout') return ctx.account ? this.logout(ctx) : this.authHome(ctx);
      if (command && ['signup', 'login', 'link'].includes(command[1])) {
        await this.deleteInput(ctx, message, true);
        if (ctx.account) return this.accountPage(ctx);
        this.authPrompt(ctx, command[1]);
        if (command[1] === 'link' && command[2]) return this.authenticateInput(ctx, ctx.prompt, command[2].trim());
        return;
      }
      if (ctx.prompt?.kind === 'auth' && (!command || !['start', 'menu', 'help', 'cancel', 'stop', 'account', 'logout', 'login', 'signup', 'link'].includes(command[1]))) {
        const prompt = ctx.prompt;
        await this.deleteInput(ctx, message, true);
        if (prompt !== ctx.prompt || prompt.expires < this.now() || prompt.revision !== ctx.revision || message.document) throw new Error('Account prompt expired. Choose Log in, Create account or Link account again.');
        return this.authenticateInput(ctx, prompt, text);
      }
      if (!ctx.account) {
        if ((text && (!command || !['start', 'menu', 'help', 'cancel', 'stop'].includes(command[1]))) || message.document) await this.deleteInput(ctx, message, true);
        return this.authHome(ctx);
      }
    }
    if (this.connections && command?.[1] === 'connections') return this.connections.menu(ctx);
    if (this.connections && ctx.prompt?.kind === 'accountConnection' && !command) return this.connections.message(ctx, message);
    if (ctx.prompt?.kind === 'executionPreset' && !command) return this.executionPresets.message(ctx, message);
    if (this.funding && command?.[1] === 'funding') return this.funding.menu(ctx);
    if (this.funding && ctx.prompt?.kind === 'funding' && !command) return this.funding.message(ctx,message);
    if (this.robinhoodMenus && ctx.chain === 'robinhood') return this.robinhoodMenus.message(ctx, message);
    if (command && ['start', 'menu', 'help'].includes(command[1])) return this.modes(ctx);
    if (command && ['status', 'cancel'].includes(command[1])) return this.home(ctx);
    if (command?.[1] === 'stopall') return this.stop(ctx);
    if (command?.[1] === 'stop') return this.stop(ctx, ctx.tool || undefined);
    if (command?.[1] === 'run') return this.review(ctx);
    if (command && ['wallets','positions','activity'].includes(command[1])) return this.action(ctx, command[1]);
    if (command?.[1] === 'settings') return this.home(ctx);
    if (command?.[1] === 'set') {
      await this.deleteInput(ctx, message, true); this.editable(ctx);
      if (!ctx.tool) return this.modes(ctx);
      const match = (command[2] || '').match(/^(\w+)\s+([\s\S]+)$/);
      if (!match) throw new Error('Use /set settingName value, or tap a setting in the menu.');
      if (!copyLike(ctx.tool) && Object.hasOwn(strategyFields, match[1])) {
        await this.save(ctx, this.updateToolStrategy(ctx, match[1], match[2]));
        return this.say(ctx, `${strategyFields[match[1]].label} saved.`, [[this.homeButton(ctx)]]);
      }
      if (!this.fieldAllowed(ctx, match[1])) throw new Error('Use this mode’s settings menu. Manual fees require Advanced settings.');
      const next = structuredClone(ctx.settings); this.setToolField(next, ctx.tool, match[1], match[2]); await this.save(ctx, next);
      return this.say(ctx, `${fields[match[1]].label} saved.`, [[this.homeButton(ctx)]]);
    }
    // Delete unexpected pasted values too, so an expired prompt does not leave a key visible.
    if (text || message.document) await this.deleteInput(ctx, message, true);
    const prompt = ctx.prompt;
    if (!prompt || prompt.expires < this.now() || prompt.revision !== ctx.revision || (prompt.tool && prompt.tool !== ctx.tool)) throw new Error('Choose what to import or change from the menu first. Then send the value again.');
    if (prompt.kind === 'manual') {
      if (message.document) throw new Error('Send the manual order value as text.');
      return this.manualInput(ctx, prompt, text);
    }
    this.editable(ctx);
    let value = text;
    if (message.document) {
      if (prompt.kind !== 'preset' || message.document.file_size > 262144 || !/\.json$/i.test(message.document.file_name || '')) throw new Error('Use Import full setup JSON for a .json preset up to 256 KB.');
      value = await this.api.document(message.document.file_id);
      this.editable(ctx);
      if (prompt !== ctx.prompt || prompt.revision !== ctx.revision) throw new Error('Setup changed while downloading. Import the preset again.');
    }
    if (prompt.kind === 'generateWallets') {
      if (!/^\d+$/.test(value)) throw new Error('Send a whole number of wallets to generate.');
      return this.generateWallets(ctx, Number(value));
    }
    let next = structuredClone(ctx.settings);
    if (prompt.kind === 'field') this.setToolField(next, ctx.tool, prompt.key, value);
    else if (prompt.kind === 'keys') { const current = toolWallets(next, ctx.tool); next.wallets.push(...importWallets(value, current, false, ctx.tool).slice(current.length)); }
    else if (prompt.kind === 'preset') {
      next = importSettings(value);
      const locked = await this.lockedWallets(ctx);
      if ([...locked].some(key => !next.wallets.some(w => w.publicKey === key))) throw new Error('The imported preset omits a wallet with positions, portfolio allocations, or pending transactions. Keep that wallet in your setup.');
    } else if (prompt.kind === 'walletAmount') {
      const wallet = next.wallets.find(w => w.publicKey === prompt.publicKey);
      if (!wallet) throw new Error('Wallet no longer exists.');
      wallet.amount = parseField('buyAmount', value); this.setToolField(next, ctx.tool, 'amountMode', 'custom');
    } else if (prompt.kind === 'strategyField') {
      next = this.updateToolStrategy(ctx, prompt.key, value);
    } else if (prompt.kind === 'walletBudget') {
      if (!getStrategy(next, ctx.tool).advanced) throw new Error('Enable Advanced settings first.');
      next = setWalletBudget(next, ctx.tool, next.wallets.findIndex(w => w.publicKey === prompt.publicKey), value);
    } else throw new Error('Choose a setting from the menu.');
    await this.save(ctx, next);
    this.say(ctx, prompt.kind === 'field' ? `${fields[prompt.key].label} saved.` : 'Saved.');
    return this.home(ctx);
  }
  async review(ctx) {
    if (this.accounts && !ctx.account) return this.authHome(ctx);
    if (!ctx.tool) return this.modes(ctx);
    this.editable(ctx); ctx.prompt = null;
    const selected = this.runSettings(ctx), validated = validateSettings(selected, ctx.tool);
    const generation = ctx.generation, revision = ctx.revision, s = ctx.tool === 'sniper' ? sniperRunSettings(selected) : selected, fee = await this.platformFee(ctx);
    if (s.mode === 'live') await this.legacyCheck(ctx, true);
    if (generation !== ctx.generation || revision !== ctx.revision) return;
    if (!copyLike(ctx.tool)) {
      const strategy = getStrategy(s, ctx.tool), limits = resolvedStrategy(strategy).limits;
      const budgets = validated.wallets.map(w => `${short(w.publicKey)}: ${decimal(w.budget, 9)} SOL`);
      return this.say(ctx, `Ready to start ${tools[ctx.tool]} · ${s.mode.toUpperCase()}\nToken: ${strategy.baseMint}\nQuote: ${strategy.quoteMint}\n${s.wallets.length} wallets · ${decimal(validated.wallets.reduce((n, w) => n + w.budget, 0n), 9)} SOL total budget\n${budgets.join('\n')}\n\n${profiles[strategy.preset].name}${strategy.advanced ? ' · Advanced on' : ''}\n${limits.deployPercent}% deployed · ${limits.targetPercent}% target token share · ±${limits.bandPercent} points\nPriority ${decimal(validated.fees.priority, 9)} · Jito ${decimal(validated.fees.jito, 9)} · Helius ${decimal(validated.fees.helius, 9)} SOL\nThis run submits real transactions until Stop.${fee.text}`, [[this.button(ctx, `▶ Start ${s.mode.toUpperCase()}`, 'launch', { revision: ctx.revision, feeVersion: fee.version }, 120000)], [this.homeButton(ctx)]]);
    }
    this.say(ctx, `Ready to start ${s.mode.toUpperCase()}\n${s.wallets.length} wallets · ${s.leads.split(/\s+/).filter(Boolean).length} leads\nBuy: ${s.amountMode === 'random' ? `${s.randomMin}–${s.randomMax}` : s.amountMode === 'custom' ? s.wallets.map((w, i) => `${i + 1}: ${w.amount}`).join(', ') : s.buyAmount} ${s.funding === 'sol' ? 'SOL' : 'lead quote token'} per wallet\nSell: ${s.sellMode}\nPriority ${s.prioritySol} · Jito ${s.jitoSol} · Helius ${s.heliusSol} SOL (${s.senderTier})\nThis run submits real transactions until you press Stop.${fee.text}`, [[this.button(ctx, `▶ Start ${s.mode.toUpperCase()}`, 'launch', { revision: ctx.revision, feeVersion: fee.version }, 120000)], [this.homeButton(ctx)]]);
  }
  async launch(ctx, args) {
    if (this.accounts && !ctx.account) return this.authHome(ctx);
    if (!ctx.tool) return this.modes(ctx);
    this.editable(ctx);
    if (args.revision !== ctx.revision) throw new Error('Settings changed. Review this run again.');
    validateSettings(this.runSettings(ctx), ctx.tool);
    const requestedGeneration = ctx.generation;
    if (ctx.settings.mode === 'live') await this.legacyCheck(ctx, true);
    if (requestedGeneration !== ctx.generation) return;
    this.editable(ctx);
    this.checkSlot(ctx); this.ensureEngine(ctx);
    const kind = ctx.tool, raw = strategyRunSettings(ctx.settings, kind);
    if (this.feePolicy) raw.agreedFeeVersion = args.feeVersion;
    const generation = ++ctx.generation; ctx.startKind = kind;
    ctx.startTask = Promise.resolve().then(() => {
      if (generation !== ctx.generation) throw new Error('Run stopped.');
      return ctx.engine.start(raw, kind);
    }).then(() => { if (generation === ctx.generation && ctx.engine.state === 'running') this.say(ctx, `${tools[kind]} · ${ctx.settings.mode.toUpperCase()} trading is running.`, [[this.button(ctx, '⏹ Stop', 'stop')], [this.homeButton(ctx)]]); })
      .catch(error => { if (generation === ctx.generation && !this.notifyRunFailure(ctx, kind)) this.say(ctx, error.message, [[this.homeButton(ctx)]]); })
      .finally(() => { ctx.startTask = null; ctx.startKind = null; ctx.lastActive = this.now(); });
    this.say(ctx, 'Starting your trading session… You can press Stop during connection setup.', [[this.button(ctx, '⏹ Stop', 'stop')]]);
  }
  checkSlot(ctx) {
    if (this.runtimeManager) return; // Shared host manager counts web and Telegram together.
    if (!stopped(ctx.engine)) return;
    const active = [...this.users.values()].filter(c => c !== ctx && (c.startTask || c.closingTask || !stopped(c.engine))).length;
    if (active >= this.maxActive) throw new Error('All trading slots are busy. Try again when a run stops.');
  }
  ensureEngine(ctx) {
    if (this.runtimeManager) {
      if (!ctx.account) throw new Error('Log in before starting.');
      const engine = this.runtimeManager.get(ctx.account.id);
      if (ctx.engine !== engine) {
        this.detachEngine(ctx); ctx.engine = engine; ctx.seen.clear(); ctx.lastState = null;
        ctx.engineListener = () => this.verifyAccountLink(ctx).then(() => this.changed(ctx)).catch(() => {}); engine.on('change', ctx.engineListener);
      }
      return;
    }
    if (ctx.engine?.failed) { ctx.engine.close().catch(() => {}); ctx.engine = null; }
    if (!ctx.engine) {
      ctx.engine = this.engineFactory(ctx.store); ctx.seen.clear(); ctx.lastState = null;
      ctx.engine.on('change', () => this.changed(ctx));
    }
  }
  stop(ctx, kind) {
    if (!kind || !ctx.startTask || ctx.startKind === kind) ++ctx.generation;
    if (!kind || ctx.tool === kind) { ctx.prompt = null; ctx.manualDraft = null; }
    for (const [key, action] of ctx.actions) if ((!kind || action.tool === kind) && ['launch', 'withdraw', 'release', 'manualConfirm'].includes(action.op)) ctx.actions.delete(key);
    ctx.engine?.stop(this.runtimeManager ? kind : undefined);
    const label = kind ? tools[kind] : this.runtimeManager ? 'All modes' : 'Trading';
    const state = kind ? this.modeStatus(ctx, kind).state : ctx.engine?.state || 'stopped';
    this.say(ctx, `${label}: ${state === 'stopped' ? '⚪ Stopped.' : 'Stopping.'} New trades are disabled; already-broadcast transactions are being checked. Wallet assets and LP positions stay in place.`, [[this.homeButton(ctx)]], { urgent: true, replaceQueue: true });
  }
  notifyRunFailure(ctx, kind, status = this.modeStatus(ctx, kind)) {
    const reason = status?.stopReason;
    if (!reason) return false;
    const key = `${ctx.account?.id || ctx.id}:${ctx.chain || 'solana'}:${kind}:${reason.id}`;
    ctx.failureNotices ||= new Set();
    if (ctx.failureNotices.has(key)) return true;
    ctx.failureNotices.add(key);
    if (ctx.failureNotices.size > 100) ctx.failureNotices.delete(ctx.failureNotices.values().next().value);
    ctx.notices = ctx.notices.filter(notice => notice.kind !== kind);
    if (!ctx.notices.length) { clearTimeout(ctx.noticeTimer); ctx.noticeTimer = null; }
    // Expire pre-error launch/manual buttons. Restart always requires a fresh
    // review; the latch is cleared only by an explicit new worker operation.
    for (const [id, action] of ctx.actions || []) if (action.tool === kind && ['launch', 'rhStart', 'manualConfirm', 'rhManualConfirm'].includes(action.op)) ctx.actions.delete(id);
    this.say(ctx, `⏹ ${tools[kind] || 'Trading'} stopped new trades.\n\n${reason.message}\n\nReview Activity and press Start when ready. Already-broadcast transactions will still be checked.`, [[this.homeButton(ctx)]], { urgent: true });
    return true;
  }
  changed(ctx) {
    if (!ctx.engine || this.closing) return;
    const status = ctx.engine.status(), firstSnapshot = ctx.lastState == null;
    const runs = status.concurrent ? runKinds.map(kind => [kind, ctx.engine.status(kind)]) : [[status.kind || ctx.tool || 'copy', status]];
    for (const [kind, run] of runs) this.notifyRunFailure(ctx, kind, run);
    if (ctx.lastState !== status.state) {
      if (ctx.lastState && status.state === 'stopped' && !runs.some(([, run]) => run.stopReason)) this.say(ctx, '⚪ Stopped. Open the menu to start another run.', [[this.homeButton(ctx)]]);
      ctx.lastState = status.state;
    }
    const events = runs.flatMap(([kind, run]) => (run.events || []).map(event => ({ ...event, kind, id: `${kind}:${event.id}`, stoppedForError: !!run.stopReason }))).sort((a, b) => b.at - a.at);
    const fresh = firstSnapshot ? [] : events.filter(event => !ctx.seen.has(event.id));
    for (const event of events) ctx.seen.add(event.id);
    if (ctx.seen.size > 1000) ctx.seen = new Set(events.map(e => e.id));
    ctx.issueNotices ||= new Map();
    for (const event of fresh.reverse()) if (event.at >= this.now() - 30000 && ['confirmed','error','warn','paper'].includes(event.level)) {
      if (['error', 'warn'].includes(event.level)) {
        if (event.stoppedForError) continue;
        const key = `${event.kind}:${event.level}:${event.message}`;
        if (ctx.issueNotices.has(key) && this.now() - ctx.issueNotices.get(key) < 60000) continue;
        ctx.issueNotices.set(key, this.now());
        if (ctx.issueNotices.size > 100) ctx.issueNotices.delete(ctx.issueNotices.keys().next().value);
      }
      const message = event.level === 'error' ? tradingIssue(event.message) : event.message;
      ctx.notices.push({ kind: event.kind, text: `${tools[event.kind]} · ${event.level.toUpperCase()}: ${message}${event.wallet ? `\nWallet: ${short(event.wallet)}` : ''}${event.signature && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(event.signature) ? `\nSignature: ${event.signature}` : ''}` });
    }
    if (ctx.notices.length > 30) ctx.notices.splice(0, ctx.notices.length - 30);
    if (ctx.notices.length && !ctx.noticeTimer) ctx.noticeTimer = setTimeout(() => { ctx.noticeTimer = null; this.say(ctx, ctx.notices.splice(0).map(notice => notice.text).join('\n\n').slice(0, 3500), undefined, { notification: true }); }, 1000);
  }
  reap() {
    if (this.runtimeManager) return;
    for (const ctx of this.users.values()) if (ctx.engine && !ctx.startTask && !ctx.closingTask && stopped(ctx.engine) && this.now() - ctx.lastActive > 60000) {
      ctx.closingTask = ctx.engine.close().catch(() => {}).finally(() => { ctx.engine = null; ctx.closingTask = null; });
    }
  }
  async close() {
    this.closing = true; clearInterval(this.reaper);
    await this.funding?.service.close?.();
    if (this.runtimeManager) {
      for (const ctx of this.users.values()) { clearTimeout(ctx.noticeTimer); ++ctx.generation; this.detachEngine(ctx); }
      await Promise.allSettled([...this.users.values()].map(ctx => ctx.queue));
      return; // The shared host owns shutdown of account runtimes.
    }
    for (const ctx of this.users.values()) { clearTimeout(ctx.noticeTimer); ++ctx.generation; ctx.engine?.stop(); }
    await Promise.allSettled([...this.users.values()].map(async ctx => { await ctx.queue; await ctx.startTask; if (ctx.closingTask) await ctx.closingTask; else await ctx.engine?.close(); }));
  }
}
