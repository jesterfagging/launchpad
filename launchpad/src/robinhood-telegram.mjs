import { randomUUID } from 'node:crypto';
import { formatUnits, parseUnits } from 'viem';
import { TOOL_NAMES, EVM_NATIVE } from '../public/chains.mjs';
import { walletTool, WALLET_LIMITS } from '../public/wallet-limits.mjs';
import { cleanRobinhoodSettings, evmWallet, evmAddress, ensureRobinhoodAccount } from './robinhood-settings.mjs';
import { strictUnits } from './robinhood-rpc.mjs';

const short = value => `${value.slice(0, 8)}…${value.slice(-4)}`;
const amountText = (value, decimals = 18) => Number(formatUnits(BigInt(value || 0), decimals)).toLocaleString('en-US', { maximumSignificantDigits: 8 });
const budgetText = (settings, kind) => {
  const budget = settings.tools[kind][['market', 'liquidity'].includes(kind) ? 'budgetEth' : 'budget'];
  return budget == null || budget === '' ? 'Set your ETH budget' : !['market', 'liquidity'].includes(kind) && Number(budget) === 0 ? 'No run budget cap' : `${budget} ETH / wallet`;
};
const fields = {
  leads: ['Target addresses', 'One Robinhood public wallet per line, up to 100.'], developers: ['Developer wallets', 'One developer wallet per line, up to 100.'],
  token: ['Token contract', 'Enter the Robinhood token’s contract address. Launchpad discovers its trading pool automatically.'], quote: ['Pool quote override', `Normally leave this on auto. Send auto to discover the pool, or an optional quote contract. Native Robinhood ETH: ${EVM_NATIVE}`],
  budgetEth: ['Wallet budget (ETH)', 'Enter the Robinhood ETH budget per wallet. Launchpad converts pool assets automatically. Keep extra ETH for gas. Existing quote-token amounts are not reused as ETH amounts.'],
  amountMode: ['Buy sizing', 'Send fixed, random, or custom.'], buyAmount: ['Buy amount (ETH)', 'Robinhood ETH per wallet, including the Launchpad fee. The pool’s stock or other quote token is converted automatically. Gas is extra.'], randomMin: ['Random minimum (ETH)','Enter the smallest Robinhood ETH buy amount.'], randomMax: ['Random maximum (ETH)','Enter the largest Robinhood ETH buy amount.'], budget: ['Wallet budget','Enter the quote-token budget per wallet.'],
  sellMode: ['Sell rule','Send mirror, percent, or hybrid-percent.'], mirrorFraction: ['Mirror sale fraction','Send true to match the target’s sale fraction, or false to exit the whole copied position.'], percentStep: ['Price step %','Enter a price increase percentage.'], sellPercent: ['Sell fraction %','Percentage to sell at each step.'],
  preset: ['Strategy','Send conservative, balanced, active, or advanced.'], targetPercent: ['Target inventory %','Token inventory target: 5–95%.'], driftPercent: ['Rebalance band %','Inventory drift: 1–40%.'], intervalMs: ['Strategy interval','Milliseconds, from 10000 to 3600000.'], rangeBps: ['LP range width','Range width in basis points, from 100 to 9000.'],
  rpcUrl: ['Robinhood RPC','Paste your HTTPS Robinhood mainnet RPC URL, including its API key if needed.'], reserveEth: ['ETH gas reserve','Enter ETH to leave in each trading wallet.'], maxGasGwei: ['Max gas price','Enter the gas-price cap in Gwei.'], priorityGwei: ['Priority gas','Enter the priority gas price in Gwei.'], slippageBps: ['Slippage basis points','Enter 1–5000 basis points. 200 = 2%.'], pollMs: ['RPC polling','Enter 250–30000 milliseconds.'], rpcRequestsPerSecond: ['RPC requests / second','Enter 1–1000.'], maxSignalAgeMs: ['Maximum buy signal age','Enter 1000–120000 milliseconds.'],
  pool: ['Trade pool key','Send JSON with currency0, currency1, fee, tickSpacing, and hooks. Send auto to clear.'], feePool: ['ETH conversion pool','Send the quote-token/ETH conversion pool as JSON. Send auto for automatic discovery.'], launchSource: ['Launch source','Send both, pons, or long.'],
  autoCompoundFees: ['Auto-compound fees', 'Send true to reinvest earned fees into their LP position, or false to leave them claimable. Network costs still apply.'],
  maxPositions: ['LP positions per wallet','Enter 1–20. The account cap is 20 positions total; the wallet budget is split between its positions.'],
};
const common = new Set(['rpcUrl','reserveEth','maxGasGwei','priorityGwei','slippageBps','pollMs','rpcRequestsPerSecond','maxSignalAgeMs']);
const numeric = new Set(['targetPercent','driftPercent','intervalMs','rangeBps','maxPositions','slippageBps','pollMs','rpcRequestsPerSecond','maxSignalAgeMs','percentStep','sellPercent']);

export class RobinhoodTelegram {
  constructor(bot, service) { this.bot = bot; this.manager = service.runtimes; this.policy = service.policy; }
  button(ctx, title, op, args) { return this.bot.button(ctx, title, op, args); }
  say(ctx, message, rows = []) { return this.bot.say(ctx, message, [...rows, [this.button(ctx, '‹ Tool menu', 'home'), this.button(ctx, 'Change chain', 'chains')]]); }
  async attach(ctx, account) {
    this.bot.detachEngine(ctx); clearTimeout(ctx.noticeTimer); ctx.noticeTimer = null; ctx.notices = [];
    ctx.account = account; ctx.chain = 'robinhood'; ctx.store = this.manager.storeFor(account.id);
    const saved = await this.manager.readSettings(account.id); ctx.settings = saved.settings; ctx.settingsRevision = saved.revision; ctx.settingsStamp = JSON.stringify(saved.settings);
    ctx.actions.clear(); ctx.tool = null; ctx.navigation++; ctx.revision++; ctx.generation++; ctx.prompt = null; ctx.manualDraft = null; ctx.seen.clear(); ctx.lastState = null;
    ctx.engine = this.manager.get(account.id); ctx.engineListener = () => this.bot.verifyAccountLink(ctx).then(() => this.bot.changed(ctx)).catch(() => {}); ctx.engine.on('change', ctx.engineListener);
  }
  async refresh(ctx) {
    if (!ctx.account || ctx.startTask || ctx.engine?.busy) return false;
    const saved = await this.manager.readSettings(ctx.account.id); if (saved.revision === ctx.settingsRevision) return false;
    ctx.settings = saved.settings; ctx.settingsRevision = saved.revision; ctx.settingsStamp = JSON.stringify(saved.settings); ctx.revision++; ctx.prompt = null; ctx.manualDraft = null; return true;
  }
  async save(ctx, settings, generation) {
    if (await this.refresh(ctx)) throw Error('Settings changed on the website. Open this menu again.');
    const result = generation ? await this.manager.generateWallets(ctx.account.id, settings, ctx.settingsRevision, generation.count, ctx.tool) : await this.manager.saveSettings(ctx.account.id, settings, ctx.settingsRevision);
    ctx.settings = result.settings; ctx.settingsRevision = result.revision; ctx.settingsStamp = JSON.stringify(result.settings); ctx.revision++; ctx.prompt = null; return result;
  }
  modes(ctx) {
    ctx.tool = null; ctx.navigation++; ctx.prompt = null; ctx.manualDraft = null;
    this.bot.say(ctx, 'Launchpad · Robinhood Chain\n\nChoose your trading tool. All buy amounts and new strategy budgets use ETH. Switching menus leaves active runs running.', [
      ...Object.entries(TOOL_NAMES).map(([kind, title]) => [this.button(ctx, `${title} · ${ctx.engine.status(kind).state}`, 'select', { kind })]),
      ...(this.bot.funding ? [[this.button(ctx,'Funding','funding')]] : []),
      [this.button(ctx, 'Tutorial · RPCs & API keys', 'tutorial')],
      [this.button(ctx, 'Account & cashback', 'account'), this.button(ctx, 'Stop all Robinhood tools', 'stopAll')],
      [this.button(ctx, 'Change chain', 'chains')],
    ]);
  }
  async home(ctx) {
    if (!ctx.tool) return this.modes(ctx);
    ctx.prompt = null; const kind = ctx.tool, status = ctx.engine.status(kind), count = ctx.settings.runWallets[kind].length;
    const rows = [[this.button(ctx, `Wallets · ${count} selected`, 'rhWallets')]];
    if (kind === 'copy') rows.push([this.button(ctx, 'Target addresses', 'rhField', { key: 'leads' })]);
    if (kind === 'sniper') rows.push([this.button(ctx, 'Developer wallets', 'rhField', { key: 'developers' }), this.button(ctx, 'Launch source', 'rhField', { key: 'launchSource' })]);
    rows.push([this.button(ctx, ['copy','sniper'].includes(kind) ? 'Buy settings' : 'Strategy settings', 'rhGroup', { group: 'buy' })]);
    if (['copy','sniper'].includes(kind)) rows.push([this.button(ctx, 'Sell settings', 'rhGroup', { group: 'sell' }), this.button(ctx, 'Manual buy / sell', 'rhManual')]);
    if (kind === 'market') rows.push([this.button(ctx, 'Manual inventory sale', 'rhManual')]);
    rows.push([this.button(ctx, 'Gas & execution', 'rhGroup', { group: 'connection' }), this.button(ctx, 'Advanced', 'rhGroup', { group: 'advanced' })]);
    rows.push([this.button(ctx, 'Gas & fee presets · P1 / P2 / P3', 'executionPresets')]);
    rows.push([this.button(ctx, 'Account', 'account')]);
    rows.push([this.button(ctx, 'Positions', 'positions'), this.button(ctx, 'Activity', 'activity')]);
    rows.push([this.button(ctx, status.state === 'stopped' ? '▶ Review & start' : 'Review run', 'rhReview'), this.button(ctx, status.state === 'stopped' ? '⚪ Stopped' : '⏹ Stop', 'stop')], [this.button(ctx, 'Other Robinhood tools', 'modes'), this.button(ctx, 'Change chain', 'chains')]);
    this.bot.say(ctx, `Launchpad · Robinhood\n${TOOL_NAMES[kind]}\n\n${status.state.toUpperCase()} · ${count}/${WALLET_LIMITS[kind]} wallets selected\n${status.positions?.length || 0} open positions · ${status.pending?.length || 0} pending\nBudget: ${budgetText(ctx.settings, kind)}\n\n${kind === 'liquidity' ? 'Choose a token and an ETH budget. Launchpad finds the pool, buys its assets and returns available withdrawal proceeds to ETH.' : 'Buys spend ETH. ETH-funded positions sell back to ETH. Conversions are handled automatically.'}\nKeep extra ETH for gas.${['copy','sniper'].includes(kind) ? '\nCopy / Sniping share the 25-wallet cap.' : ''}`, rows);
  }
  group(ctx, group) {
    const copy = ['copy','sniper'].includes(ctx.tool);
    const keys = group === 'buy' ? copy ? ['amountMode','buyAmount','randomMin','randomMax','budget'] : ['token','budgetEth','preset', ...(ctx.tool === 'liquidity' ? ['autoCompoundFees'] : [])] : group === 'sell' ? ['sellMode','mirrorFraction','percentStep','sellPercent'] : group === 'connection' ? ['reserveEth','maxGasGwei','priorityGwei','slippageBps'] : ['pool','feePool', ...(!copy ? ['quote'] : []),'maxSignalAgeMs','intervalMs', ...(ctx.tool === 'market' ? ['targetPercent','driftPercent'] : ctx.tool === 'liquidity' ? ['rangeBps','maxPositions'] : [])];
    const visibleValue = key => ['budgetEth','budget','buyAmount','randomMin','randomMax'].includes(key) ? ctx.settings.tools[ctx.tool][key] ? `${ctx.settings.tools[ctx.tool][key]} ETH` : 'Not set' : key === 'preset' ? ctx.settings.tools[ctx.tool].preset : key === 'quote' ? ctx.settings.tools[ctx.tool].quote ? short(ctx.settings.tools[ctx.tool].quote) : 'Automatic' : key === 'autoCompoundFees' ? ctx.settings.tools[ctx.tool][key] ? 'On' : 'Off' : '';
    return this.say(ctx, `${TOOL_NAMES[ctx.tool]} · ${group === 'buy' ? 'Budget & strategy' : group === 'connection' ? 'Gas & execution' : group === 'sell' ? 'Sell settings' : 'Advanced'}\n${group === 'buy' ? 'Amounts are in Robinhood ETH. Pool conversions are automatic.' : 'Choose a setting to edit.'}`, keys.map(key => [this.button(ctx, `${copy && key === 'budget' ? 'Wallet budget (ETH)' : fields[key][0]}${visibleValue(key) ? ` · ${visibleValue(key)}` : ''}`, 'rhField', { key })]));
  }
  wallets(ctx, manual = false) {
    const wallets = ctx.settings.wallets.filter(w => w.tool === walletTool(ctx.tool)), selection = manual ? ctx.manualDraft.wallets : ctx.settings.runWallets[ctx.tool];
    this.say(ctx, `Robinhood wallets · ${wallets.length}/${WALLET_LIMITS[ctx.tool]}\n${selection.length} selected${manual ? ' for this manual trade' : ''}.\nNew wallets need funding before trading.`, [
      ...wallets.map(w => [this.button(ctx, `${selection.includes(w.publicKey) ? '☑' : '☐'} ${w.label} · ${short(w.publicKey)}`, 'rhToggle', { key: w.publicKey, manual, id: manual ? ctx.manualDraft.id : undefined, revision: ctx.revision })]),
      [this.button(ctx, 'Select all', 'rhAll', { manual, id: manual ? ctx.manualDraft.id : undefined, revision: ctx.revision }), this.button(ctx, 'Clear selection', 'rhAll', { manual, id: manual ? ctx.manualDraft.id : undefined, none: true, revision: ctx.revision })],
      ...(manual ? [[this.button(ctx, 'Continue', 'rhManualSize', { id: ctx.manualDraft.id, revision: ctx.revision })]] : [[this.button(ctx, 'Generate wallets', 'rhGenerate'), this.button(ctx, 'Import keys', 'rhImport')], [this.button(ctx, 'Full addresses', 'rhAddresses'), this.button(ctx, 'Custom amounts', 'rhAmounts')]]),
    ]);
  }
  prompt(ctx, kind, message, extra = {}) { ctx.prompt = { kind: 'robinhood', input: kind, chain: 'robinhood', tool: ctx.tool, revision: ctx.revision, expires: this.bot.now() + 5 * 60000, ...extra }; return this.say(ctx, message); }
  async account(ctx) {
    const account = await this.bot.accounts.get(ctx.account.id), data = await ensureRobinhoodAccount(this.bot.accounts, account.id);
    this.say(ctx, `Account: ${account.username}\nRobinhood cashback wallet\n${data.mainWallet.publicKey}\n\nCashback: ${account.cashbackBps / 100}% of independently verified Launchpad fees. Accrued rewards are not yet paid. This wallet is not selected for trading.`, [...(this.bot.connections ? [[this.button(ctx, 'Connections · RPCs & API keys', 'accountConnections')]] : []), [this.button(ctx, 'Log out', 'logout')]]);
  }
  async review(ctx) {
    const policy = await this.policy.get(ctx.account.id); if (!policy.ready) throw Error('Robinhood trading is awaiting the host’s execution-contract and fee-wallet setup.');
    const strategy = ['market','liquidity'].includes(ctx.tool), tool = ctx.settings.tools[ctx.tool], count = ctx.settings.runWallets[ctx.tool].length;
    if (strategy && (!tool.budgetEth || Number(tool.budgetEth) <= 0)) return this.prompt(ctx, 'field', fields.budgetEth[1], { key: 'budgetEth' });
    const total = strategy ? `\nConfigured total: ${formatUnits(parseUnits(tool.budgetEth, 18) * BigInt(count), 18)} ETH across ${count} wallet(s)` : '';
    this.say(ctx, `${TOOL_NAMES[ctx.tool]} · Review\n\n${count} selected wallet(s)\nBudget: ${budgetText(ctx.settings, ctx.tool)}${total}${strategy ? `\nToken: ${tool.token || 'Not set'}\nPool and conversion routes: ${tool.pool || tool.quote ? 'Saved override' : 'Automatic'}` : ''}\nETH gas reserve: ${ctx.settings.reserveEth} / wallet\n\n${policy.description}\n${ctx.tool === 'liquidity' ? policy.liquidityDescription : ''}\n\nRoutes and balances are checked before trading. Start accepts these fees. Stop prevents new submissions; it leaves existing positions open.`, [[this.button(ctx, '▶ Start on Robinhood', 'rhStart', { revision: ctx.revision, feeVersion: policy.version, generation: ctx.generation })]]);
  }
  async action(ctx, op, args = {}) {
    if (!ctx.account) return this.bot.authHome(ctx);
    if (op === 'account') return this.account(ctx);
    if (op === 'modes') return this.modes(ctx);
    if (op === 'select') { if (!(args.kind in TOOL_NAMES)) throw Error('Choose a trading tool.'); ctx.tool = args.kind; ctx.navigation++; return this.home(ctx); }
    if (op === 'home') return this.home(ctx);
    if (op === 'stopAll') return this.bot.stop(ctx);
    if (op === 'stop') return this.bot.stop(ctx, ctx.tool || undefined);
    if (!ctx.tool) return this.modes(ctx);
    if (args.revision !== undefined && args.revision !== ctx.revision) throw Error('Settings changed. Reopen this menu.');
    if ((args.manual || op.startsWith('rhManual') && op !== 'rhManual') && args.id !== ctx.manualDraft?.id) throw Error('This manual request changed. Open Manual buy / sell again.');
    if (op === 'rhWallets') return this.wallets(ctx);
    if (op === 'rhToggle' || op === 'rhAll') {
      const keys = ctx.settings.wallets.filter(w => w.tool === walletTool(ctx.tool)).map(w => w.publicKey), next = structuredClone(ctx.settings);
      const selected = new Set(args.manual ? ctx.manualDraft?.wallets : next.runWallets[ctx.tool]);
      if (op === 'rhAll') { selected.clear(); if (!args.none) keys.forEach(k => selected.add(k)); }
      else { if (!keys.includes(args.key)) throw Error('Wallet selection changed.'); selected.has(args.key) ? selected.delete(args.key) : selected.add(args.key); }
      if (args.manual) { if (!ctx.manualDraft) throw Error('Open Manual buy / sell again.'); ctx.manualDraft.wallets = [...selected]; }
      else { next.runWallets[ctx.tool] = [...selected]; await this.save(ctx, next); }
      return this.wallets(ctx, args.manual);
    }
    if (op === 'rhGenerate') return this.prompt(ctx, 'generate', `How many ${TOOL_NAMES[ctx.tool]} wallets? The group cap is ${WALLET_LIMITS[ctx.tool]}.`);
    if (op === 'rhImport') return this.prompt(ctx, 'import', 'Paste one EVM private key per line: 64 hexadecimal characters, with or without 0x. Wallet keys are encrypted and stored on Launchpad’s server for automated signing. Launchpad deletes the input message after reading it.');
    if (op === 'rhAmounts') return this.prompt(ctx, 'amounts', 'Send one wallet address and custom Robinhood ETH buy amount per line, separated by a space.');
    if (op === 'rhAddresses') return this.say(ctx, ctx.settings.wallets.filter(w => w.tool === walletTool(ctx.tool)).map(w => `${w.label}\n${w.publicKey}`).join('\n\n') || 'No wallets.');
    if (op === 'rhGroup') return this.group(ctx, args.group);
    if (op === 'rhField') { if (!fields[args.key]) throw Error('Unknown setting.'); return this.prompt(ctx, 'field', args.key === 'budget' && ['copy','sniper'].includes(ctx.tool) ? 'Wallet budget (ETH)\nEnter the maximum Robinhood ETH to spend per wallet in this run. Gas is extra.' : `${fields[args.key][0]}\n${fields[args.key][1]}`, { key: args.key }); }
    if (op === 'rhReview') return this.review(ctx);
    if (op === 'rhStart') {
      if (args.generation !== ctx.generation) throw Error('This Start button expired after Stop. Review the run again.');
      const raw = structuredClone(ctx.settings); raw.agreedFeeVersion = args.feeVersion;
      ctx.startKind = ctx.tool; const generation = ctx.generation;
      const task = ctx.engine.start(raw, ctx.tool); ctx.startTask = task;
      this.say(ctx, 'Connecting to Robinhood… Stop is available during startup.', [[this.button(ctx, '⏹ Stop', 'stop')]]);
      try { await task; if (generation === ctx.generation && !this.bot.notifyRunFailure(ctx, ctx.tool)) return this.home(ctx); }
      catch (error) { if (!this.bot.notifyRunFailure(ctx, ctx.tool)) throw error; }
      finally { if (ctx.startTask === task) ctx.startTask = null; }
    }
    if (op === 'positions' || op === 'activity') {
      const status = await this.manager.view(ctx.account.id, ctx.tool);
      if (op === 'activity') return this.say(ctx, status.events.slice(0, 12).map(e => `${new Date(e.at).toISOString().slice(11, 19)} ${e.level}: ${e.message}`).join('\n\n') || 'No activity.');
      const rows = ctx.tool === 'liquidity' ? status.positions.filter(p => p.tokenId).flatMap(p => [[this.button(ctx, `Withdraw #${p.tokenId}`, 'rhWithdraw', { id: p.id, wallet: p.wallet })], ...(p.pool?.protocol === 'v2' ? [] : [[this.button(ctx, `Claim fees #${p.tokenId}`, 'rhClaimFees', { id: p.id, wallet: p.wallet })]])]) : [];
      if (status.state === 'stopped') for (const [wallet, funds] of Object.entries(status.inventory || {})) {
        if (status.pending.some(p => p.wallet === wallet)) continue;
        if (ctx.tool === 'liquidity' && (BigInt(funds.tokenAvailable || 0) || BigInt(funds.quoteAvailable || 0))) rows.push([this.button(ctx, `Return idle funds to ETH · ${short(wallet)}`, 'rhConvert', { wallet })]);
        if (!status.positions.some(p => p.wallet === wallet)) rows.push([this.button(ctx, `Release idle budget · ${short(wallet)}`, 'rhRelease', { wallet })]);
      }
      const positions = status.positions.map(p => `${p.symbol || 'LP'} · ${short(p.wallet)}\n${p.tokenId ? `Position #${p.tokenId}` : `${p.decimals == null ? `${p.remaining} raw units` : amountText(p.remaining, p.decimals)} ${p.symbol || 'tokens'}`}`);
      const budgets = Object.entries(status.inventory || {}).filter(([,funds]) => funds.budgetCurrency === EVM_NATIVE).map(([wallet,funds]) => `${short(wallet)} · ${amountText(funds.ethAvailable)} ETH available`);
      return this.say(ctx, `${TOOL_NAMES[ctx.tool]} · Positions\n\n${positions.join('\n\n') || 'No open positions.'}${budgets.length ? `\n\nManaged ETH\n${budgets.join('\n')}` : ''}\n\n${status.pending.length} pending transaction(s)\nReleasing an idle budget ends tracking; assets stay in the wallet.`, rows);
    }
    if (op === 'rhRelease') { await ctx.engine.releaseInventory(args.wallet, ctx.tool); return this.action(ctx, 'positions'); }
    if (op === 'rhConvert') { if (ctx.tool !== 'liquidity') throw Error('Choose Liquidity first.'); const raw = { ...ctx.settings, agreedFeeVersion: (await this.policy.get(ctx.account.id)).version }; await ctx.engine.convertInventory(args.wallet, raw); return this.action(ctx, 'positions'); }
    if (op === 'rhClaimFees') { const raw = { ...ctx.settings, agreedFeeVersion: (await this.policy.get(ctx.account.id)).version }; await ctx.engine.claimFees({ id: args.id, wallet: args.wallet }, raw); return this.action(ctx, 'positions'); }
    if (op === 'rhWithdraw') { const raw = { ...ctx.settings, agreedFeeVersion: (await this.policy.get(ctx.account.id)).version }; await ctx.engine.withdraw({ id: args.id, wallet: args.wallet }, raw); return this.action(ctx, 'positions'); }
    if (op === 'rhManual') { if (!['copy','sniper','market'].includes(ctx.tool)) throw Error('Manual trading is unavailable in this tool.'); ctx.manualDraft = { id: randomUUID(), wallets: [], side: ctx.tool === 'market' ? 'sell' : 'buy', kind: ctx.tool }; const id = ctx.manualDraft.id; return this.say(ctx, ctx.tool === 'market' ? 'Stop Market Making first, then sell managed inventory.' : 'Manual buy / sell · LIVE\nChoose an action, token and wallets, then review before submitting. Buys spend ETH. Sells return ETH.', [[...(ctx.tool === 'market' ? [] : [this.button(ctx, 'Buy', 'rhManualSide', { side: 'buy', id })]), this.button(ctx, 'Sell', 'rhManualSide', { side: 'sell', id })]]); }
    if (op === 'rhManualSide') { if (!ctx.manualDraft || !['buy','sell'].includes(args.side) || ctx.tool === 'market' && args.side !== 'sell') throw Error('Open Manual buy / sell again.'); ctx.manualDraft.side = args.side; return this.prompt(ctx, 'manual-token', 'Enter the token contract address.'); }
    if (op === 'rhManualSize') {
      if (!ctx.manualDraft?.wallets.length || !ctx.manualDraft.token) throw Error('Choose a token and at least one wallet.');
      this.prompt(ctx, 'manual-size', ctx.manualDraft.side === 'sell' ? 'Sell what percentage of each selected wallet’s holdings? Choose below or send a number above 0 and up to 100. Sells return ETH.' : `Enter the Robinhood ETH amount per selected wallet, including the Launchpad fee. ${ctx.manualDraft.wallets.length} wallets selected; network fees are extra.`);
      if (ctx.manualDraft.side === 'sell') return this.say(ctx, 'Sell percentage', [[10,25,50,100].map(percent => this.button(ctx, `${percent}%`, 'rhManualPercent', { id: ctx.manualDraft.id, percent }))]);
      return;
    }
    if (op === 'rhManualPercent') return this.manualReview(ctx, String(args.percent));
    if (op === 'rhManualConfirm') {
      const draft = ctx.manualDraft; if (!draft || draft.id !== args.id || draft.kind !== ctx.tool || args.generation !== ctx.generation) throw Error('Review this manual trade again.');
      const raw = { ...ctx.settings, agreedFeeVersion: args.feeVersion }; ctx.manualDraft = null;
      const status = await ctx.engine.manualTrade(raw, draft, ctx.tool);
      if (this.bot.notifyRunFailure(ctx, ctx.tool)) return;
      return this.say(ctx, (status.manualResult?.results || []).map(r => `${r.label || short(r.wallet)}: ${r.state}${r.error ? ` · ${r.error}` : ''}`).join('\n') || 'Trade request completed. Check Activity for receipts.');
    }
    throw Error('Open a fresh Robinhood menu with /start.');
  }
  async message(ctx, message) {
    const value = String(message.text || '').trim(), command = value.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1];
    if (['status','cancel','settings'].includes(command)) return this.home(ctx);
    if (command === 'run') return this.review(ctx);
    if (['positions','activity'].includes(command)) return this.action(ctx, command);
    if (command === 'wallets') return this.wallets(ctx);
    await this.bot.deleteInput(ctx, message, true);
    const prompt = ctx.prompt;
    if (!prompt || prompt.kind !== 'robinhood' || prompt.chain !== ctx.chain || prompt.tool !== ctx.tool || prompt.revision !== ctx.revision || prompt.expires < this.bot.now() || message.document) throw Error('Choose a setting from the Robinhood menu, then send its value.');
    const next = structuredClone(ctx.settings);
    if (prompt.input === 'generate') { await this.save(ctx, next, { count: Number(value) }); return this.wallets(ctx); }
    if (prompt.input === 'import') {
      const rows = value.split(/[\s,]+/).filter(Boolean).map((privateKey, i) => evmWallet({ privateKey, tool: walletTool(ctx.tool), label: `Imported ${next.wallets.length + i + 1}` }));
      next.wallets.push(...rows); next.runWallets[ctx.tool].push(...rows.map(w => w.publicKey)); await this.save(ctx, cleanRobinhoodSettings(next, ctx.settings)); return this.wallets(ctx);
    }
    if (prompt.input === 'amounts') {
      for (const line of value.split('\n').filter(Boolean)) { const [key, amount, extra] = line.trim().split(/\s+/); const wallet = next.wallets.find(w => w.publicKey === evmAddress(key) && w.tool === walletTool(ctx.tool)); if (!wallet || !amount || extra) throw Error('Use wallet-address amount, one per line.'); wallet.amount = amount; }
      await this.save(ctx, next); return this.wallets(ctx);
    }
    if (prompt.input === 'field') {
      const key = prompt.key; let parsed = numeric.has(key) ? Number(value) : ['mirrorFraction', 'autoCompoundFees'].includes(key) ? value === 'true' ? true : value === 'false' ? false : null : value;
      if (key === 'quote' && value.toLowerCase() === 'auto') parsed = '';
      if (['mirrorFraction', 'autoCompoundFees'].includes(key) && parsed === null) throw Error('Send true or false.');
      if (['pool','feePool'].includes(key)) { try { parsed = value === 'auto' ? null : JSON.parse(value); } catch { throw Error('Enter valid pool-key JSON or auto.'); } }
      if (common.has(key)) next[key] = parsed; else next.tools[ctx.tool][key] = parsed;
      await this.save(ctx, next); return this.home(ctx);
    }
    const draft = ctx.manualDraft; if (!draft || draft.kind !== ctx.tool) throw Error('Open Manual buy / sell again.');
    if (prompt.input === 'manual-token') { draft.token = evmAddress(value); draft.quote = ''; ctx.prompt = null; return this.wallets(ctx, true); }
    if (prompt.input === 'manual-size') return this.manualReview(ctx, value);
    throw Error('Choose a Robinhood setting first.');
  }
  async manualReview(ctx, value) {
    const draft = ctx.manualDraft;
    if (!draft?.wallets.length || !draft.token) throw Error('Choose a token and at least one wallet.');
    if (draft.side === 'buy' && strictUnits(value, 18) <= 0n) throw Error('Enter a positive ETH amount.');
    if (draft.side === 'sell' && (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0 || Number(value) > 100)) throw Error('Enter a sell percentage above 0 and up to 100, with at most two decimals.');
    draft.amount = value; draft.percent = Number(value); ctx.prompt = null; const policy = await this.policy.get(ctx.account.id);
    return this.say(ctx, `Review manual ${draft.side.toUpperCase()} · LIVE\nToken: ${draft.token}\n${draft.wallets.length} wallets selected\n\n${draft.side === 'sell' ? `${draft.percent}% of each selected wallet’s ${ctx.tool === 'market' ? 'managed inventory' : 'holdings'} → ETH` : `${draft.amount} ETH / wallet · ${formatUnits(strictUnits(value, 18) * BigInt(draft.wallets.length), 18)} ETH total input`}\nMax gas ${ctx.settings.maxGasGwei} Gwei · priority ${ctx.settings.priorityGwei} Gwei\n\n${policy.description}\nConfirm accepts these fees. Network fees are extra.`, [[this.button(ctx, `Confirm LIVE ${draft.side.toUpperCase()}`, 'rhManualConfirm', { id: draft.id, revision: ctx.revision, generation: ctx.generation, feeVersion: policy.version })]]);
  }
}
