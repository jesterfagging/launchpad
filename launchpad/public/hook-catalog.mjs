// Transfer hook rules (v71.28): the shared, inert catalogue used by the server,
// the browser and the on-chain program's reference encoder. A hooked coin is a
// Token-2022 mint on Meteora's Dynamic Bonding Curve whose transfers call
// Launchpad's hook program; the program enforces the rules below on every
// transfer while the coin is on the curve. The swap that completes the curve
// revokes the hook (Meteora's program does this before migration), so every
// rule ends at graduation. Nothing here signs, spends or calls a program.
// Percentages are basis points on chain (1% = 100 bps) unless a setting says
// ppm (parts per million, for shares below 0.01%); the catalogue shows percent.
//
// Route: a rule whose extra accounts derive from the mint alone ('any') trades
// through Meteora's own swap path and every app that uses it. A rule that needs
// an account per trader (a wallet record, an allowlist entry, a gate-token
// account) or an instruction only Launchpad adds (the tithe donation) is 'curve':
// Launchpad resolves those accounts when it builds the trade, other routers cannot,
// so the coin trades on Launchpad only while it is on the curve. This is the same
// split Hooked calls "Any DEX" and "Hooked route only".
export const HOOK_VENUES = Object.freeze(['meteora']);
export const HOOK_MAX_RULES = 4;
export const HOOK_LIMITS = Object.freeze({ allowlistBatch: 20, allowlistTotal: 5000, blocklistBatch: 28, blocklistTotal: 200, slidingLevels: 5 });
export const HOOK_PARAM_COUNT = 6;

const setting = (key, label, { min, max, step = 1, value, unit = '', options = null, labels = null, hint = '', when = null }) => Object.freeze({ key, label, min, max, step, value, unit, options: options ? Object.freeze(options) : null, labels: labels ? Object.freeze(labels) : null, hint, when });
const rule = (id, kind, name, group, summary, rule, { route = 'any', needsWalletState = false, needsGlobalState = false, needsSysvar = false, needsBlocklist = false, settings = [], note = '', extra = null, app = null, appName = '' } = {}) => Object.freeze({ id, kind, name, group, summary, rule, route, needsWalletState, needsGlobalState, needsSysvar, needsBlocklist, settings: Object.freeze(settings), note, extra, app, appName, available: true });

export const HOOK_GROUPS = Object.freeze([
  Object.freeze({ id: 'hold', name: 'Who can hold', summary: 'Who may receive the coin at all.' }),
  Object.freeze({ id: 'sell', name: 'When you can sell', summary: 'Caps on selling and on how fast a bag can leave.' }),
  Object.freeze({ id: 'fair', name: 'Fair launch', summary: 'Caps on buying and on how much one wallet may hold.' }),
  Object.freeze({ id: 'where', name: 'Where it trades', summary: 'Which counterparties a transfer may have.' }),
  Object.freeze({ id: 'when', name: 'When it trades', summary: 'Time windows and rhythms.' }),
  Object.freeze({ id: 'physics', name: 'Physics in tokens', summary: 'Per-buy caps that move with time and with buying.' }),
  Object.freeze({ id: 'paid', name: 'Who gets paid', summary: 'A payment every trade must carry.' }),
]);

export const HOOK_ROUTES = Object.freeze({
  any: Object.freeze({ id: 'any', name: 'Trades anywhere', text: 'Trades through Meteora’s swap path and every app that uses it.' }),
  curve: Object.freeze({ id: 'curve', name: 'Launchpad route only', text: 'Trades on Launchpad while it is on the curve: Launchpad supplies the per-wallet accounts (or adds the payment) this rule needs and other routers do not. Trades anywhere after graduation.' }),
  // v71.35/v71.36: a rule that locks pool trades to one outside app while the coin is on the curve — the trade's transaction must carry the app's mark
  // (the host names it: the app's co-signing wallet, or the swap program it builds through). Launchpad's own Buy and Sell are off for the coin until graduation.
  app: Object.freeze({ id: 'app', name: 'App only', text: 'Trades only through the named app while it is on the curve: the trade’s transaction must carry the app’s mark (its co-signing wallet, or the swap it builds), so Launchpad’s Buy and Sell (and every other router) are off for the coin until it graduates. Trades anywhere after graduation.' }),
});

const PCT_SUPPLY = '% of supply';
export const HOOK_RULES = Object.freeze([
  // --- Who can hold -------------------------------------------------------------------------------------------------
  rule('allowlist', 1, 'Allowlist', 'hold', 'Only wallets you approve can receive the coin.', 'A transfer to a wallet that is not on the allowlist fails. The creator adds and removes wallets after launch; the pool and the creator are always allowed.', { route: 'curve' }),
  rule('blocklist', 17, 'Blocklist', 'hold', 'Up to 200 wallets you name can never receive the coin.', 'A transfer to a wallet on the blocklist fails. The list is written before the first trade and cannot be changed afterwards, by anyone.', { needsBlocklist: true, extra: 'blocklist', note: 'Enter 1 to 200 wallet addresses. The list is sealed by the first trade.' }),
  rule('holder_gated', 2, 'Holder-gated', 'hold', 'Only wallets holding another token can receive the coin.', 'A transfer fails unless the receiving wallet holds at least the set amount of the gate token at that moment; checked on every buy and transfer.', { route: 'curve', settings: [setting('minAmount', 'Minimum held', { min: 0.000001, max: 1e9, step: 0.000001, value: 1, hint: 'in the gate token’s units' })], extra: 'gateMint', note: 'The gate token is chosen at launch (any SPL or Token-2022 mint).' }),
  // --- When you can sell ---------------------------------------------------------------------------------------------
  rule('holder_vesting', 3, 'Holder vesting', 'sell', 'Each wallet’s tokens unlock on their own clock from the moment it buys.', 'A wallet’s qualifying receipts are locked; after the cliff a share unlocks every period until all of it is free. Tokens received after the early-buyer window are not locked. The wallet needs a small on-chain record, which Launchpad creates with the first trade.', {
    route: 'curve', needsWalletState: true,
    settings: [
      setting('earlyHours', 'Only vest early buyers', { min: 0, max: 168, step: 1, value: 0, unit: 'h', hint: '0 = every wallet vests' }),
      setting('cliffHours', 'Cliff', { min: 0, max: 168, step: 1, value: 24, unit: 'h' }),
      setting('unlockPct', 'Unlock each period', { min: 0.1, max: 100, step: 0.1, value: 10, unit: '%' }),
      setting('periodHours', 'Unlock period', { min: 1, max: 168, step: 1, value: 24, unit: 'h' }),
      setting('minBuyPct', 'Minimum qualifying buy', { min: 0.001, max: 1, step: 0.001, value: 0.05, unit: PCT_SUPPLY, hint: 'smaller receipts are not locked' }),
    ],
  }),
  rule('hot_potato', 18, 'Hot potato', 'sell', 'Whoever bought last holds the hot potato: they can’t sell or send.', 'The wallet whose buy was the most recent qualifying one cannot transfer the coin out until another wallet buys, or until the potato goes cold.', { needsGlobalState: true, settings: [setting('minBuyPct', 'Minimum buy to pass', { min: 0, max: 1, step: 0.001, value: 0.01, unit: PCT_SUPPLY, hint: '0 = any buy' }), setting('coldMinutes', 'Potato goes cold after', { min: 0, max: 1440, step: 1, value: 0, unit: 'min', hint: '0 = never' })] }),
  rule('anti_dump', 4, 'Anti-dump caps', 'sell', 'A loose buy cap and a tight sell cap, each a share of the supply.', 'The hook tells buys from sells and caps each side separately: no single buy above the buy cap, no single sell or send above the sell cap.', { settings: [setting('maxBuyPct', 'Max per buy', { min: 0, max: 5, step: 0.05, value: 2, unit: PCT_SUPPLY, hint: '0 = no buy cap' }), setting('maxSellPct', 'Max per sell', { min: 0.1, max: 2, step: 0.05, value: 0.25, unit: PCT_SUPPLY })] }),
  rule('sliding_caps', 5, 'Sliding caps', 'sell', 'The max per buy and max per sell change as the curve fills.', 'Per-buy and per-sell caps are set per level; the level steps up each time the curve passes a breakpoint of its progress to graduation (SOL raised against the graduation amount).', {
    needsGlobalState: true,
    settings: [
      setting('levels', 'Levels', { min: 1, max: 5, value: 3, options: [1, 2, 3, 4, 5] }),
      setting('buy0', 'Max per buy at launch', { min: 0, max: 100, step: 0.05, value: 2, unit: PCT_SUPPLY, hint: '0 = no cap' }),
      setting('sell0', 'Max per sell at launch', { min: 0.01, max: 100, step: 0.01, value: 1, unit: PCT_SUPPLY }),
      setting('at1', 'Breakpoint 1 at', { min: 1, max: 99, step: 1, value: 25, unit: '% to graduation', when: 2 }),
      setting('buy1', 'Max per buy after 1', { min: 0, max: 100, step: 0.05, value: 3, unit: PCT_SUPPLY, when: 2 }),
      setting('sell1', 'Max per sell after 1', { min: 0.01, max: 100, step: 0.01, value: 1.5, unit: PCT_SUPPLY, when: 2 }),
      setting('at2', 'Breakpoint 2 at', { min: 1, max: 99, step: 1, value: 60, unit: '% to graduation', when: 3 }),
      setting('buy2', 'Max per buy after 2', { min: 0, max: 100, step: 0.05, value: 5, unit: PCT_SUPPLY, when: 3 }),
      setting('sell2', 'Max per sell after 2', { min: 0.01, max: 100, step: 0.01, value: 2, unit: PCT_SUPPLY, when: 3 }),
      setting('at3', 'Breakpoint 3 at', { min: 1, max: 99, step: 1, value: 80, unit: '% to graduation', when: 4 }),
      setting('buy3', 'Max per buy after 3', { min: 0, max: 100, step: 0.05, value: 10, unit: PCT_SUPPLY, when: 4 }),
      setting('sell3', 'Max per sell after 3', { min: 0.01, max: 100, step: 0.01, value: 5, unit: PCT_SUPPLY, when: 4 }),
      setting('at4', 'Breakpoint 4 at', { min: 1, max: 99, step: 1, value: 90, unit: '% to graduation', when: 5 }),
      setting('buy4', 'Max per buy after 4', { min: 0, max: 100, step: 0.05, value: 20, unit: PCT_SUPPLY, when: 5 }),
      setting('sell4', 'Max per sell after 4', { min: 0.01, max: 100, step: 0.01, value: 10, unit: PCT_SUPPLY, when: 5 }),
    ],
    note: 'Breakpoints are shares of the way to graduation and must rise from one to the next.',
  }),
  rule('graduated_sell_caps', 6, 'Graduated sell caps', 'sell', 'Small holders sell freely; the bigger a wallet’s bag, the smaller its per-sell cap.', 'The share of supply a wallet may sell in one transfer slides from the small-holder cap down to the big-bag cap as its balance grows to the bag size; above the bag size the big-bag cap applies.', { settings: [setting('smallCapPct', 'Sell cap for small holders', { min: 0.05, max: 5, step: 0.05, value: 1, unit: PCT_SUPPLY }), setting('bigCapPct', 'Sell cap for the biggest bags', { min: 0.01, max: 1, step: 0.01, value: 0.1, unit: PCT_SUPPLY }), setting('bagPct', 'Bag size for the smallest cap', { min: 0.5, max: 10, step: 0.1, value: 3, unit: PCT_SUPPLY })] }),
  // --- Fair launch -----------------------------------------------------------------------------------------------------
  rule('max_per_wallet', 7, 'Max per wallet', 'fair', 'No wallet can hold more than a share of the supply.', 'The hook checks what the receiving wallet now holds and refuses the transfer if it would go over. The pool and the creator are exempt.', { settings: [setting('maxPct', 'Max per wallet', { min: 0.1, max: 50, step: 0.1, value: 1, unit: PCT_SUPPLY })] }),
  rule('chapters', 9, 'Chapters', 'fair', 'A max per wallet that grows with the coin: it doubles every chapter of volume.', 'The per-wallet cap starts small and doubles every time the coin’s bought volume passes another chapter. Selling back into the pool always works.', { needsGlobalState: true, settings: [setting('startPct', 'Starting max per wallet', { min: 0.1, max: 5, step: 0.1, value: 1, unit: PCT_SUPPLY }), setting('volumeMillions', 'Volume per chapter', { min: 1, max: 100, step: 1, value: 10, unit: 'M tokens' })] }),
  rule('rising_max_per_wallet', 8, 'Rising max per wallet', 'fair', 'Every wallet’s max holding starts small and rises for everyone on a timer you set.', 'The per-wallet cap starts at the starting share and rises by a fixed step, or doubles, every interval from the first trade until it reaches 100%. The pool and the creator are exempt.', { settings: [setting('startPct', 'Starting max per wallet', { min: 0.01, max: 5, step: 0.01, value: 0.1, unit: PCT_SUPPLY }), setting('mode', 'How it rises', { min: 0, max: 1, value: 0, options: [0, 1], labels: ['Fixed step', 'Doubles'] }), setting('stepPct', 'Rises by', { min: 0.01, max: 5, step: 0.01, value: 0.1, unit: PCT_SUPPLY, when: 'mode:0' }), setting('everyMinutes', 'Every', { min: 1, max: 1440, step: 1, value: 5, unit: 'min' })] }),
  rule('sniper_fee_cap', 21, 'Sniper-fee cap', 'fair', 'For a launch window, buys that pay a big priority fee or Jito tip are refused.', 'The hook reads each buy’s transaction: a compute-unit price above the priority-fee cap, or a SOL transfer to a Jito tip account above the tip cap, fails the buy. Sells are never blocked; the creator is exempt.', { needsSysvar: true, settings: [setting('windowMinutes', 'Launch window', { min: 0, max: 1440, step: 1, value: 10, unit: 'min', hint: '0 = forever' }), setting('maxPriorityFeeSol', 'Max priority fee per buy', { min: 0, max: 0.05, step: 0.0005, value: 0.002, unit: 'SOL' }), setting('maxTipSol', 'Max Jito tip per buy', { min: 0, max: 0.05, step: 0.0005, value: 0.002, unit: 'SOL' })] }),
  rule('trade_guard', 10, 'Trade guard', 'fair', 'Every buy, sell and transfer is capped at the same share of supply.', 'No single transfer, in any direction, may move more than the set share of the total supply. The creator is not exempt.', { settings: [setting('maxTradePct', 'Max per trade', { min: 0.05, max: 10, step: 0.05, value: 0.5, unit: PCT_SUPPLY })] }),
  rule('anti_bundle', 11, 'Anti-bundle', 'fair', 'Only a few trades per block.', 'The hook counts the pool trades in each Solana block and refuses any past the limit, so a bundle cannot take the launch in one block.', { needsGlobalState: true, settings: [setting('maxTradesPerBlock', 'Max trades per block', { min: 1, max: 20, step: 1, value: 3, unit: 'trades' })] }),
  // --- Where it trades --------------------------------------------------------------------------------------------------
  rule('venue_locked', 12, 'Venue-locked', 'where', 'Trades only through its Meteora pool; a plain wallet-to-wallet transfer is refused.', 'Every transfer must have the pool as its sender or its receiver; sending the coin to another wallet or another venue fails.'),
  rule('dex_only', 19, 'DEX-only', 'where', 'Moves only when a program moves it, like a swap; a plain wallet-to-wallet send is refused.', 'A transfer is allowed only when another program (the pool, a router) called the token program; a transfer signed directly from a wallet fails.'),
  rule('p2p_only', 20, 'P2P-only', 'where', 'It moves only wallet to wallet; nobody can buy or sell it on a market.', 'Only the creator can buy from the bonding curve, and nobody can sell into it; holders pass the coin wallet to wallet. When the curve fills it graduates and the rule switches off.', { note: 'The creator buys the curve and hands the coin out.' }),
  // v71.35/v71.36: app-only trading. The host owner names each app's on-chain mark (LAUNCHPAD_HOOK_FOMO_MARK, LAUNCHPAD_HOOK_PUMP_APP_MARK:
  // a wallet that co-signs the app's trades, a program the app invokes, or a program invoked with a given account slot filled);
  // the mark is packed into the rule's parameters at launch and the launch page offers the rule only when the host names it.
  rule('fomo_only', 26, 'FOMO-only', 'where', 'While on the curve it trades only through the FOMO app.', 'A pool trade is allowed only when the transaction carries FOMO’s mark as the host names it (on mainnet, FOMO’s own wallet co-signing the trade); any other route, Launchpad included, is refused while the coin is on the curve. The creator is exempt; sends always work; the rule ends at graduation.', { route: 'app', needsSysvar: true, app: 'fomo', appName: 'FOMO', note: 'Launchpad’s Buy and Sell are off for this coin until it graduates; holders trade it in FOMO.' }),
  rule('pump_app_only', 27, 'Pump App-only', 'where', 'While on the curve it trades only through the Pump App.', 'A pool trade is allowed only when the transaction carries the Pump App’s mark as the host names it (on mainnet, the OKX router swap the Pump App builds through Jupiter’s app API, commission slot filled); any other route, Launchpad included, is refused while the coin is on the curve. The creator is exempt; sends always work; the rule ends at graduation.', { route: 'app', needsSysvar: true, app: 'pumpApp', appName: 'Pump App', note: 'Launchpad’s Buy and Sell are off for this coin until it graduates; holders trade it in the Pump App. Another app that builds the same swap can trade it too.' }),
  // --- When it trades -----------------------------------------------------------------------------------------------------
  rule('ping_pong', 14, 'Ping pong', 'when', 'Buys and sells take turns: after a buy the next trade must be a sell.', 'A pool trade of at least the minimum takes the turn; the next qualifying trade must go the other way until the turn frees up. Sends always work.', { needsGlobalState: true, settings: [setting('minTurnPct', 'Minimum to take the turn', { min: 0, max: 1, step: 0.001, value: 0.01, unit: PCT_SUPPLY, hint: '0 = any trade' }), setting('freeMinutes', 'Turn frees up after', { min: 0, max: 1440, step: 1, value: 10, unit: 'min', hint: '0 = never' })] }),
  rule('market_hours', 13, 'Market hours', 'when', 'Trades like a stock: Monday to Friday, 9:30am to 4:00pm New York time.', 'Pool trades are allowed only during New York Stock Exchange hours; daylight saving and the exchange holidays are computed on chain. Wallet-to-wallet sends always work.', { settings: [setting('afterHours', 'After hours', { min: 0, max: 1, value: 0, options: [0, 1], labels: ['Buys and sells closed', 'Sells stay open'] }), setting('holidays', 'Stock-market holidays', { min: 0, max: 1, value: 0, options: [0, 1], labels: ['Closed on holidays', 'Ignore holidays'] })] }),
  rule('trading_hours', 22, 'Trading hours', 'when', 'You set the trading week: which days it trades and the hours on each, in your time zone.', 'Pool trades are allowed only inside the open window on the chosen weekdays, in the chosen time zone (US and EU daylight-saving rules are followed on chain). A window may run past midnight. Sends always work.', {
    settings: [
      setting('openMinute', 'Opens', { min: 0, max: 1435, step: 5, value: 540, unit: 'hh:mm' }),
      setting('closeMinute', 'Closes', { min: 5, max: 1440, step: 5, value: 1020, unit: 'hh:mm', hint: 'a close at or before the open runs past midnight; 00:00–24:00 is all day' }),
      setting('weekdays', 'Days', { min: 1, max: 127, step: 1, value: 31, hint: 'bit mask, Monday = 1 … Sunday = 64' }),
      setting('tzOffset', 'Time zone offset', { min: -840, max: 840, step: 15, value: 0, unit: 'min from UTC' }),
      setting('dst', 'Daylight saving', { min: 0, max: 2, value: 0, options: [0, 1, 2], labels: ['None', 'US rules', 'EU rules'] }),
      setting('afterHours', 'Outside your hours', { min: 0, max: 1, value: 0, options: [0, 1], labels: ['Buys and sells closed', 'Sells stay open'] }),
    ],
  }),
  // --- Physics in tokens ------------------------------------------------------------------------------------------------
  rule('breathing_cap', 15, 'Breathing cap', 'physics', 'The buy cap rises and falls on the clock, forever.', 'An oscillator inside the hook swings the per-buy cap up and down on a fixed cycle around the base cap; it never drops below the floor. Sells and sends are never capped; the creator is exempt.', { settings: [setting('cycleSeconds', 'Cycle length', { min: 30, max: 3600, step: 10, value: 300, unit: 's' }), setting('baseCapPct', 'Base cap', { min: 0.1, max: 10, step: 0.1, value: 1, unit: PCT_SUPPLY }), setting('swingPct', 'Swing', { min: 10, max: 100, step: 5, value: 60, unit: '% of base' }), setting('floorPct', 'Floor', { min: 0.01, max: 5, step: 0.01, value: 0.1, unit: PCT_SUPPLY })] }),
  rule('momentum', 16, 'Momentum', 'physics', 'Buying gives the market energy, which widens the buy cap; quiet markets tighten it.', 'A damped oscillator that starts at rest: every buy kicks it and the per-buy cap swings up around the base cap, then settles as the energy decays. Sells and sends are never capped; the creator is exempt.', { needsGlobalState: true, settings: [setting('periodSeconds', 'Natural period', { min: 20, max: 1200, step: 10, value: 120, unit: 's' }), setting('dampingPct', 'Damping', { min: 1, max: 40, step: 1, value: 8, unit: '% per second' }), setting('buyEnergyPct', 'Buy energy', { min: 5, max: 100, step: 5, value: 40, unit: '%' }), setting('baseCapPct', 'Base cap', { min: 0.1, max: 10, step: 0.1, value: 1, unit: PCT_SUPPLY }), setting('floorPct', 'Floor', { min: 0.01, max: 5, step: 0.01, value: 0.25, unit: PCT_SUPPLY })] }),
  rule('resonance', 23, 'Resonance', 'physics', 'Momentum tuned for rhythm: buys that land in step pile energy on.', 'The hook keeps a beat from the first trade. A buy on the beat adds its full energy, a buy off the beat adds little; energy decays at the damping rate and widens the per-buy cap above the base cap. Sells and sends are never capped; the creator is exempt.', { needsGlobalState: true, settings: [setting('beatSeconds', 'The beat', { min: 20, max: 1200, step: 10, value: 60, unit: 's' }), setting('dampingPct', 'Damping', { min: 1, max: 20, step: 1, value: 2, unit: '% per second' }), setting('buyEnergyPct', 'Buy energy', { min: 5, max: 100, step: 5, value: 40, unit: '%' }), setting('baseCapPct', 'Base cap', { min: 0.1, max: 10, step: 0.1, value: 1, unit: PCT_SUPPLY }), setting('floorPct', 'Floor', { min: 0.01, max: 5, step: 0.01, value: 0.25, unit: PCT_SUPPLY })] }),
  rule('coupled_resonator', 24, 'Coupled resonator', 'physics', 'Two oscillators inside one coin: buys energise the first, which sets the cap; the second stores energy and feeds it back.', 'Buys kick the first oscillator, which swings the per-buy cap around the base cap; energy flows between the two at the coupling rate so the swing outlasts the buying. Sells and sends are never capped; the creator is exempt.', { needsGlobalState: true, settings: [setting('periodSeconds', 'Natural period', { min: 20, max: 1200, step: 10, value: 180, unit: 's' }), setting('couplingPct', 'Coupling', { min: 1, max: 60, step: 1, value: 20, unit: '% per second' }), setting('dampingPct', 'Damping', { min: 0, max: 20, step: 1, value: 2, unit: '% per second' }), setting('buyEnergyPct', 'Buy energy', { min: 5, max: 100, step: 5, value: 40, unit: '%' }), setting('baseCapPct', 'Base cap', { min: 0.1, max: 10, step: 0.1, value: 1, unit: PCT_SUPPLY }), setting('floorPct', 'Floor', { min: 0.01, max: 5, step: 0.01, value: 0.25, unit: PCT_SUPPLY })] }),
  // --- Who gets paid ----------------------------------------------------------------------------------------------------
  rule('tithe', 25, 'Tithe', 'paid', 'Every trade donates to a cause you choose.', 'A pool trade is allowed only if the same transaction pays at least the donation in SOL to the recipient set at launch. Launchpad adds the donation to every trade it builds; the creator is exempt.', { route: 'curve', needsSysvar: true, settings: [setting('donationSol', 'Donation per trade', { min: 0.001, max: 0.5, step: 0.001, value: 0.005, unit: 'SOL' })], extra: 'titheRecipient', note: 'The recipient is a wallet address written on chain at launch.' }),
]);
export const HOOK_RULE_IDS = Object.freeze(HOOK_RULES.map(r => r.id));
export const HOOK_AVAILABLE_RULES = HOOK_RULES;
export const HOOK_AVAILABLE_RULE_IDS = HOOK_RULE_IDS;
export const hookRuleById = id => HOOK_RULES.find(r => r.id === id) || null;
export const hookRuleByKind = kind => HOOK_RULES.find(r => r.kind === Number(kind)) || null;

// Pairs that cannot be combined on one coin: they cap the same thing or decide the same question.
const CONFLICTS = Object.freeze([
  ['allowlist', 'blocklist'], ['allowlist', 'holder_gated'], ['blocklist', 'holder_gated'],
  ['anti_dump', 'trade_guard'], ['anti_dump', 'graduated_sell_caps'], ['anti_dump', 'sliding_caps'], ['trade_guard', 'sliding_caps'], ['graduated_sell_caps', 'sliding_caps'], ['trade_guard', 'graduated_sell_caps'],
  ['max_per_wallet', 'chapters'], ['max_per_wallet', 'rising_max_per_wallet'], ['chapters', 'rising_max_per_wallet'],
  ['venue_locked', 'dex_only'], ['venue_locked', 'p2p_only'], ['dex_only', 'p2p_only'],
  ['market_hours', 'trading_hours'],
  ['breathing_cap', 'momentum'], ['breathing_cap', 'resonance'], ['breathing_cap', 'coupled_resonator'], ['momentum', 'resonance'], ['momentum', 'coupled_resonator'], ['resonance', 'coupled_resonator'],
  ['anti_dump', 'breathing_cap'], ['anti_dump', 'momentum'], ['anti_dump', 'resonance'], ['anti_dump', 'coupled_resonator'],
  ['sliding_caps', 'breathing_cap'], ['sliding_caps', 'momentum'], ['sliding_caps', 'resonance'], ['sliding_caps', 'coupled_resonator'],
  ['p2p_only', 'hot_potato'], ['p2p_only', 'ping_pong'], ['p2p_only', 'anti_bundle'], ['p2p_only', 'sniper_fee_cap'],
  // An app-only coin is never traded by Launchpad, so rules that need Launchpad to build the trade (Launchpad route) and the other venue rules cannot join it.
  ['fomo_only', 'pump_app_only'],
  ...['fomo_only', 'pump_app_only'].flatMap(app => ['venue_locked', 'dex_only', 'p2p_only', 'allowlist', 'holder_gated', 'holder_vesting', 'tithe'].map(other => [app, other])),
].map(p => Object.freeze(p)));
export const HOOK_CONFLICTS = CONFLICTS;
export const hookRulesConflict = (a, b) => CONFLICTS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

// Hooked rules a transfer hook on this curve cannot honestly offer, with the reason (shown in the docs and the launch page).
export const HOOK_NOT_OFFERED = Object.freeze([
  Object.freeze({ name: 'Custom hook', why: 'Rules written by an AI into an interpreter program. Launchpad’s hook runs fixed, audited-by-reading rules with your numbers; a free-form rule set is not one of them.' }),
  Object.freeze({ name: 'Pegs', why: 'A one-object-per-unit collection with its own art is a different product (NFT-backed units), not a transfer rule.' }),
  Object.freeze({ name: 'Social trading, OpenSea only', why: 'They lock a coin to a trading path Launchpad cannot name on chain. FOMO-only and Pump App-only (an app the host owner names) and Venue-locked and DEX-only are the rules that apply here.' }),
  Object.freeze({ name: 'Buyer rewards', why: 'A reward vault paying every buyer is a rewards product; Launchpad’s Holders, Gotchi and AI Agent launch modes pay holders from the curve’s own fees.' }),
  Object.freeze({ name: 'Reactive pair, Entangled, Beacon', why: 'Linked tokens launch two coins in one transaction and read each other’s pool during a transfer. Not in this release; it can follow.' }),
]);

export const WEEKDAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
/** Time zones the Trading hours picker offers: a fixed offset plus the daylight-saving rule the program knows (0 none, 1 US, 2 EU). */
export const HOOK_TIMEZONES = Object.freeze([
  { id: 'UTC', name: 'UTC', offset: 0, dst: 0 },
  { id: 'America/New_York', name: 'New York (Eastern)', offset: -300, dst: 1 },
  { id: 'America/Chicago', name: 'Chicago (Central)', offset: -360, dst: 1 },
  { id: 'America/Denver', name: 'Denver (Mountain)', offset: -420, dst: 1 },
  { id: 'America/Los_Angeles', name: 'Los Angeles (Pacific)', offset: -480, dst: 1 },
  { id: 'America/Sao_Paulo', name: 'São Paulo', offset: -180, dst: 0 },
  { id: 'Europe/London', name: 'London', offset: 0, dst: 2 },
  { id: 'Europe/Berlin', name: 'Berlin, Paris, Madrid', offset: 60, dst: 2 },
  { id: 'Europe/Athens', name: 'Athens, Kyiv', offset: 120, dst: 2 },
  { id: 'Europe/Moscow', name: 'Moscow', offset: 180, dst: 0 },
  { id: 'Asia/Dubai', name: 'Dubai', offset: 240, dst: 0 },
  { id: 'Asia/Kolkata', name: 'India', offset: 330, dst: 0 },
  { id: 'Asia/Singapore', name: 'Singapore, Hong Kong, Shanghai', offset: 480, dst: 0 },
  { id: 'Asia/Tokyo', name: 'Tokyo, Seoul', offset: 540, dst: 0 },
  { id: 'Australia/Brisbane', name: 'Brisbane', offset: 600, dst: 0 },
].map(z => Object.freeze(z)));

const bps = pct => Math.round(Number(pct) * 100);
const ppm = pct => Math.round(Number(pct) * 10_000);
const lamports = sol => Math.round(Number(sol) * 1e9);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const error = (message, code = 400) => Object.assign(Error(message), { statusCode: code });
const stepOk = (number, field) => { const steps = (number - field.min) / field.step; return Math.abs(steps - Math.round(steps)) <= 1e-6 * Math.max(1, Math.abs(steps)); };

/** Whether a setting applies given the rule's other values (`when`: a level count, or 'key:value'). */
export function hookSettingApplies(field, values) {
  if (field.when === null || field.when === undefined) return true;
  if (typeof field.when === 'number') return Number(values.levels) >= field.when;
  const [key, value] = String(field.when).split(':');
  return String(values[key]) === value;
}

/** Validated numbers for one rule (unknown keys dropped, absent keys take defaults). Throws 400. */
export function normalizeHookSettings(id, raw) {
  const item = hookRuleById(id); if (!item) throw error('Choose a transfer hook rule.');
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, out = {};
  for (const field of item.settings) {
    const given = input[field.key]; if (given === undefined || given === null || given === '') { out[field.key] = field.value; continue; }
    const number = Number(given);
    if (!Number.isFinite(number) || number < field.min || number > field.max || (field.options && !field.options.includes(number)) || (!field.options && !stepOk(number, field))) throw error(`${item.name}: ${field.label} must be ${field.options ? 'one of ' + field.options.join(', ') : `between ${field.min} and ${field.max}`}${field.unit ? ' ' + field.unit : ''}.`);
    out[field.key] = number;
  }
  if (id === 'sliding_caps') { let last = 0; for (let i = 1; i < out.levels; i++) { if (out['at' + i] <= last) throw error('Sliding caps: each breakpoint must be above the one before it.'); last = out['at' + i]; } }
  if (id === 'graduated_sell_caps' && out.bigCapPct > out.smallCapPct) throw error('Graduated sell caps: the big-bag cap must not exceed the small-holder cap.');
  if (id === 'breathing_cap' && out.floorPct > out.baseCapPct) throw error('Breathing cap: the floor must not exceed the base cap.');
  if ((id === 'momentum' || id === 'resonance' || id === 'coupled_resonator') && out.floorPct > out.baseCapPct) throw error(`${item.name}: the floor must not exceed the base cap.`);
  if (id === 'trading_hours' && out.weekdays % 1 !== 0) throw error('Trading hours: choose the days.');
  return out;
}

/**
 * The creator's hook choice from a launch form: `{ rules: [{ id, settings }], gateMint?, blocklist?, titheRecipient? }`
 * → a normalized, validated plan `{ version, rules, gateMint, blocklist, titheRecipient, route, needs… }`. Throws 400.
 */
export function hookLaunchRequest(raw, { address: ADDRESS = BASE58 } = {}) {
  // `address` is the wallet-address test of the chain the rules will run on (Solana's base58 by default; an EVM venue passes its own).
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw?.rules) && raw.rules.length === 0 && !raw.gateMint && !raw.blocklist?.length && !raw.titheRecipient)) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('Describe the transfer hook rules.');
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  if (!list.length) return null;
  if (list.length > HOOK_MAX_RULES) throw error(`Choose at most ${HOOK_MAX_RULES} transfer hook rules.`);
  const rules = [], ids = new Set();
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : entry?.id; const item = hookRuleById(id); if (!item) throw error('Choose a transfer hook rule from the list.');
    if (!item.available) throw error(`${item.name}: ${item.unavailableReason}`);
    if (ids.has(id)) throw error(`${item.name} is listed twice.`);
    for (const other of ids) if (hookRulesConflict(id, other)) throw error(`${item.name} cannot be combined with ${hookRuleById(other).name}.`);
    ids.add(id);
    rules.push({ id, kind: item.kind, settings: normalizeHookSettings(id, typeof entry === 'object' ? entry.settings : undefined) });
  }
  let gateMint = null, titheRecipient = null, blocklist = [];
  if (ids.has('holder_gated')) { gateMint = String(raw.gateMint || '').trim(); if (!ADDRESS.test(gateMint)) throw error('Holder-gated: enter the gate token’s mint address.'); }
  else if (raw.gateMint) throw error('A gate token requires the Holder-gated rule.');
  if (ids.has('tithe')) { titheRecipient = String(raw.titheRecipient || '').trim(); if (!ADDRESS.test(titheRecipient)) throw error('Tithe: enter the recipient’s wallet address.'); }
  else if (raw.titheRecipient) throw error('A tithe recipient requires the Tithe rule.');
  if (ids.has('blocklist')) {
    const given = Array.isArray(raw.blocklist) ? raw.blocklist : typeof raw.blocklist === 'string' ? raw.blocklist.split(/[\s,;]+/) : [];
    const seen = new Set();
    for (const w of given) { const address = String(w || '').trim(); if (!address) continue; if (!ADDRESS.test(address)) throw error(`Blocklist: “${address.slice(0, 12)}…” is not a wallet address.`); if (!seen.has(address)) { seen.add(address); blocklist.push(address); } }
    if (!blocklist.length) throw error('Blocklist: enter at least one wallet address.');
    if (blocklist.length > HOOK_LIMITS.blocklistTotal) throw error(`Blocklist: at most ${HOOK_LIMITS.blocklistTotal} wallets.`);
  } else if (raw.blocklist?.length) throw error('A blocklist requires the Blocklist rule.');
  const items = rules.map(r => hookRuleById(r.id)), appRule = items.find(r => r.route === 'app') || null;
  return {
    version: 2, rules, gateMint, blocklist, titheRecipient,
    route: appRule ? 'app' : items.some(r => r.route === 'curve') ? 'curve' : 'any',
    app: appRule ? appRule.app : null, appName: appRule ? appRule.appName : '',
    needsWalletState: items.some(r => r.needsWalletState),
    needsGlobalState: items.some(r => r.needsGlobalState),
    needsSysvar: items.some(r => r.needsSysvar),
    needsBlocklist: items.some(r => r.needsBlocklist),
  };
}

/** Packs up to four u16 values into one u64 (decimal string): value i sits at bits 16 i. */
const pack16 = values => values.reduce((acc, v, i) => acc | (BigInt(Math.round(v)) << BigInt(16 * i)), 0n);
const u = v => String(BigInt(Math.round(v)));
const zeros = n => Array.from({ length: n }, () => '0');
const six = values => { const out = values.map(v => typeof v === 'bigint' ? v.toString() : u(v)); return out.concat(zeros(HOOK_PARAM_COUNT - out.length)); };

/**
 * On-chain parameters for a rule: six u64 values as decimal strings, in the order the program reads them (see
 * contracts/curve-transfer-hook/README.md). `gateDecimals` is needed by holder_gated, `decimals` (the coin's) by chapters.
 */
export function hookRuleParams(id, settings, { gateDecimals = 0, decimals = 6, appMark = null, maxParam = 18446744073709551615n } = {}) {
  // `maxParam`: the widest number a parameter may hold — u64 for the Solana program, 2^256 − 1 for the EVM rule engine (whose amounts carry 18 decimals).
  const s = normalizeHookSettings(id, settings);
  switch (id) {
    // The app's mark (v71.36): its 32-byte key little-endian in params 0..3 (the program's packed_key), the kind in 4 and the
    // account slot of a program+account mark in 5; never a user setting (the host names it, the launch freezes it).
    case 'fomo_only': case 'pump_app_only': {
      const bytes = appMark?.keyBytes instanceof Uint8Array && appMark.keyBytes.length === 32 ? appMark.keyBytes : null, kind = HOOK_APP_MARK_KINDS[appMark?.kind] || 0;
      if (!bytes || bytes.every(b => b === 0) || !kind) throw error(`${hookRuleById(id).name}: the app’s mark is not configured on this host.`);
      const index = kind === HOOK_APP_MARK_KINDS['program-account'] ? Number(appMark.index) : 0;
      if (!Number.isInteger(index) || index < 0 || index > 63) throw error(`${hookRuleById(id).name}: the mark’s account slot must be 0 to 63.`);
      return six([...[0, 1, 2, 3].map(i => { let v = 0n; for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(bytes[i * 8 + j]); return v; }), kind, index]);
    }
    case 'allowlist': case 'blocklist': case 'venue_locked': case 'dex_only': case 'p2p_only': return zeros(HOOK_PARAM_COUNT);
    case 'holder_gated': { const base = BigInt(Math.round(s.minAmount * 10 ** Math.min(gateDecimals, 6))) * 10n ** BigInt(Math.max(0, gateDecimals - 6)); if (base > maxParam) throw error('Holder-gated: the minimum held is too large for the gate token’s decimals.'); return six([base, gateDecimals]); }
    case 'holder_vesting': return six([s.earlyHours * 3600, s.cliffHours * 3600, s.periodHours * 3600, bps(s.unlockPct), ppm(s.minBuyPct)]);
    case 'hot_potato': return six([ppm(s.minBuyPct), s.coldMinutes * 60]);
    case 'anti_dump': return six([bps(s.maxBuyPct), bps(s.maxSellPct)]);
    case 'sliding_caps': {
      const n = s.levels, buys = [0, 1, 2, 3, 4].map(i => i < n ? bps(s['buy' + i]) : 0), sells = [0, 1, 2, 3, 4].map(i => i < n ? bps(s['sell' + i]) : 0), ats = [1, 2, 3, 4].map(i => i < n ? bps(s['at' + i]) : 0);
      return six([n, pack16(buys.slice(0, 4)), pack16(sells.slice(0, 4)), pack16(ats), pack16([buys[4], sells[4]])]);
    }
    case 'graduated_sell_caps': return six([bps(s.smallCapPct), bps(s.bigCapPct), bps(s.bagPct)]);
    case 'max_per_wallet': return six([bps(s.maxPct)]);
    case 'chapters': { const volume = BigInt(s.volumeMillions) * 1_000_000n * 10n ** BigInt(decimals); if (volume > maxParam) throw error('Chapters: the volume per chapter is too large for the coin’s decimals.'); return six([bps(s.startPct), volume]); }
    case 'rising_max_per_wallet': return six([bps(s.startPct), s.mode, bps(s.stepPct), s.everyMinutes * 60]);
    case 'sniper_fee_cap': return six([s.windowMinutes * 60, lamports(s.maxPriorityFeeSol), lamports(s.maxTipSol)]);
    case 'trade_guard': return six([bps(s.maxTradePct)]);
    case 'anti_bundle': return six([s.maxTradesPerBlock]);
    case 'ping_pong': return six([ppm(s.minTurnPct), s.freeMinutes * 60]);
    case 'market_hours': return six([s.afterHours, s.holidays]);
    case 'trading_hours': return six([s.openMinute, s.closeMinute, s.weekdays, s.tzOffset + 1440, s.dst, s.afterHours]);
    case 'breathing_cap': return six([s.cycleSeconds, bps(s.baseCapPct), s.swingPct, bps(s.floorPct)]);
    case 'momentum': return six([s.periodSeconds, s.dampingPct, s.buyEnergyPct, bps(s.baseCapPct), bps(s.floorPct)]);
    case 'resonance': return six([s.beatSeconds, s.dampingPct, s.buyEnergyPct, bps(s.baseCapPct), bps(s.floorPct)]);
    case 'coupled_resonator': return six([s.periodSeconds, s.couplingPct, s.dampingPct, s.buyEnergyPct, bps(s.baseCapPct), bps(s.floorPct)]);
    case 'tithe': return six([lamports(s.donationSol)]);
    default: throw error('Unknown transfer hook rule.');
  }
}

const hhmm = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const tzName = (offset, dst) => { const zone = HOOK_TIMEZONES.find(z => z.offset === offset && z.dst === dst); if (zone) return zone.name; const sign = offset < 0 ? '-' : '+', a = Math.abs(offset); return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}${dst === 1 ? ' (US daylight saving)' : dst === 2 ? ' (EU daylight saving)' : ''}`; };
const minutesText = m => m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;

/** One plain sentence per rule with the creator's numbers filled in, for coin pages and receipts. */
export function describeHookRule(id, settings = {}) {
  const s = normalizeHookSettings(id, settings), days = mask => WEEKDAYS.filter((_, i) => mask & (1 << i)).join(', ');
  switch (id) {
    case 'allowlist': return 'Only wallets on the creator’s allowlist can receive this coin.';
    case 'blocklist': return 'Wallets on the blocklist, sealed at launch, can never receive this coin.';
    case 'holder_gated': return `Receiving wallets must hold at least ${s.minAmount} of the gate token.`;
    case 'holder_vesting': return `Bought tokens unlock ${s.unlockPct}% every ${s.periodHours} h after a ${s.cliffHours} h cliff${s.earlyHours ? `, for wallets that buy in the first ${s.earlyHours} h` : ''}; receipts under ${s.minBuyPct}% of supply are free.`;
    case 'hot_potato': return `The last wallet to buy${s.minBuyPct ? ` at least ${s.minBuyPct}% of supply` : ''} cannot sell or send until someone else buys${s.coldMinutes ? ` or ${minutesText(s.coldMinutes)} pass` : ''}.`;
    case 'anti_dump': return `${s.maxBuyPct ? `No buy above ${s.maxBuyPct}% of supply; ` : ''}no sell or send above ${s.maxSellPct}% of supply.`;
    case 'sliding_caps': { const parts = [`at launch buys up to ${s.buy0 ? s.buy0 + '%' : 'any size'}, sells up to ${s.sell0}% of supply`]; for (let i = 1; i < s.levels; i++) parts.push(`from ${s['at' + i]}% of the way to graduation buys up to ${s['buy' + i] ? s['buy' + i] + '%' : 'any size'}, sells up to ${s['sell' + i]}%`); return parts.join('; ').replace(/^./, c => c.toUpperCase()) + '.'; }
    case 'graduated_sell_caps': return `One sell can move up to ${s.smallCapPct}% of supply for small holders, falling to ${s.bigCapPct}% for bags of ${s.bagPct}% of supply or more.`;
    case 'max_per_wallet': return `No wallet can hold more than ${s.maxPct}% of the supply.`;
    case 'chapters': return `The per-wallet cap starts at ${s.startPct}% of supply and doubles every ${s.volumeMillions}M tokens of volume; selling into the pool always works.`;
    case 'rising_max_per_wallet': return `The per-wallet cap starts at ${s.startPct}% of supply and ${s.mode ? 'doubles' : `rises by ${s.stepPct}%`} every ${minutesText(s.everyMinutes)}.`;
    case 'sniper_fee_cap': return `${s.windowMinutes ? `For the first ${minutesText(s.windowMinutes)}` : 'For the life of the curve'}, buys paying over ${s.maxPriorityFeeSol} SOL in priority fees or over ${s.maxTipSol} SOL in Jito tips are refused.`;
    case 'trade_guard': return `No buy, sell or send can move more than ${s.maxTradePct}% of the supply.`;
    case 'anti_bundle': return `At most ${s.maxTradesPerBlock} pool trade${s.maxTradesPerBlock === 1 ? '' : 's'} per block.`;
    case 'venue_locked': return 'The coin moves only to and from the Meteora pool; no wallet-to-wallet transfers.';
    case 'dex_only': return 'The coin moves only when a program moves it (a swap); plain wallet-to-wallet sends are refused.';
    case 'p2p_only': return 'Only the creator can buy from the curve and nobody can sell into it; the coin passes wallet to wallet until graduation.';
    case 'fomo_only': return 'While on the curve, this coin trades only through the FOMO app; Launchpad’s Buy and Sell are off until it graduates. Sends always work.';
    case 'pump_app_only': return 'While on the curve, this coin trades only through the Pump App; Launchpad’s Buy and Sell are off until it graduates. Sends always work.';
    case 'ping_pong': return `Buys and sells take turns${s.minTurnPct ? ` (trades under ${s.minTurnPct}% of supply don’t take the turn)` : ''}${s.freeMinutes ? `; the turn frees up after ${minutesText(s.freeMinutes)}` : ''}.`;
    case 'market_hours': return `Pool trades only Monday to Friday 9:30–16:00 New York time${s.holidays ? '' : ', closed on NYSE holidays'}${s.afterHours ? '; sells stay open after hours' : ''}.`;
    case 'trading_hours': { const allDay = s.openMinute === 0 && s.closeMinute === 1440; return `Pool trades only ${allDay ? 'all day' : `${hhmm(s.openMinute)}–${hhmm(s.closeMinute)}`} ${tzName(s.tzOffset, s.dst)} on ${days(s.weekdays)}${!allDay && s.closeMinute <= s.openMinute ? ' (past midnight)' : ''}${s.afterHours ? '; sells stay open outside those hours' : ''}.`; }
    case 'breathing_cap': return `The per-buy cap breathes ±${s.swingPct}% around ${s.baseCapPct}% of supply every ${s.cycleSeconds} s, never below ${s.floorPct}%.`;
    case 'momentum': return `Buys kick a ${s.periodSeconds} s oscillator that widens the per-buy cap around ${s.baseCapPct}% of supply; it settles at ${s.dampingPct}% per second and never drops below ${s.floorPct}%.`;
    case 'resonance': return `Buys on a ${s.beatSeconds} s beat pile energy on, widening the per-buy cap above ${s.baseCapPct}% of supply; energy fades at ${s.dampingPct}% per second; floor ${s.floorPct}%.`;
    case 'coupled_resonator': return `Two coupled ${s.periodSeconds} s oscillators (${s.couplingPct}% coupling) swing the per-buy cap around ${s.baseCapPct}% of supply; floor ${s.floorPct}%.`;
    case 'tithe': return `Every pool trade pays at least ${s.donationSol} SOL to the tithe recipient.`;
    default: return '';
  }
}

/** The host settings that name an app-only rule's mark (v71.36), by the rule's `app`. */
export const HOOK_APP_SETTINGS = Object.freeze({ fomo: 'LAUNCHPAD_HOOK_FOMO_MARK', pumpApp: 'LAUNCHPAD_HOOK_PUMP_APP_MARK' });
/** The kinds of mark the hook program recognises (contracts/curve-transfer-hook/src/sysvar.rs AppMark), by their setting word. */
export const HOOK_APP_MARK_KINDS = Object.freeze({ program: 1, signer: 2, 'program-account': 3 });
const MARK_SYNTAX = 'program:<program id>, signer:<wallet>, or program:<program id>:account:<slot>';
/**
 * A host's mark setting → { kind, key, index }: `signer:<wallet>` (the wallet signs every trade the app builds), `program:<id>` (a
 * top-level instruction of the program) or `program:<id>:account:<slot>` (the program invoked with that account slot, counted
 * from 0, filled by something other than the program itself). Empty = null. Throws with the setting named; the key's base58 shape
 * is checked here, its curve by the server.
 */
export function parseHookAppMark(value, setting = 'LAUNCHPAD_HOOK_FOMO_MARK') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const bad = () => Object.assign(Error(`${setting} must be ${MARK_SYNTAX}.`), { statusCode: 500 });
  const parts = text.split(':').map(p => p.trim());
  if (parts.length !== 2 && parts.length !== 4) throw bad();
  const [word, key] = parts;
  if (!BASE58.test(key)) throw bad();
  if (parts.length === 2) { if (word !== 'program' && word !== 'signer') throw bad(); return Object.freeze({ kind: word, key, index: 0 }); }
  if (word !== 'program' || parts[2] !== 'account' || !/^\d{1,2}$/.test(parts[3]) || Number(parts[3]) > 63) throw bad();
  return Object.freeze({ kind: 'program-account', key, index: Number(parts[3]) });
}
const shortKey = key => `${String(key).slice(0, 4)}…${String(key).slice(-4)}`;
/** One sentence saying what a mark requires of a trade, for the readiness check, the admin page and the docs. */
export function describeHookAppMark(mark, appName = 'the app') {
  if (!mark) return `${appName}: no mark named; the rule is not offered.`;
  if (mark.kind === 'signer') return `${appName}: the wallet ${shortKey(mark.key)} must sign the trade (${appName}’s co-signer).`;
  if (mark.kind === 'program') return `${appName}: a top-level instruction of program ${shortKey(mark.key)} must be in the trade.`;
  return `${appName}: a top-level instruction of program ${shortKey(mark.key)} with its account ${mark.index + 1} filled (a commission or referral slot) must be in the trade.`;
}
/** The app-only rule for an app id ('fomo' | 'pumpApp'), or null. */
export const hookRuleByApp = app => HOOK_RULES.find(r => r.route === 'app' && r.app === app) || null;
/** The sentence shown where Launchpad's Buy and Sell would be, on a coin locked to an app while it is on the curve (the same text the server refuses a trade with). */
export function hookAppTradeNote(appName) {
  const name = String(appName || '').trim() || 'the app';
  return `Launchpad’s Buy and Sell are off for this coin while it is on the curve: its ${name}-only rule allows pool trades only through the ${name} app. Trade it in ${name}; after graduation it trades anywhere, Launchpad included.`;
}
/** Why an app-only rule cannot be chosen on a host that has not named the app's mark. */
export const hookAppUnavailableText = appName => `${appName || 'This app'}-only is not enabled on this host: the owner has not named the ${appName || 'app'} app’s mark.`;

export const HOOK_RULES_SUMMARY = Object.freeze([
  'Transfer hook rules run inside Launchpad’s hook program on every transfer of the coin while it is on the Meteora curve. The swap that completes the curve removes the hook, so every rule ends at graduation.',
  'The rules and their numbers are written on chain at launch. The creator can add or remove allowlist wallets later; nothing else can be changed, by anyone, and the supply is fixed at creation like every Launchpad coin.',
  'Rules marked “Trades anywhere” read only the coin’s own on-chain records, so the coin trades through Meteora’s swap path and any app that uses it. Rules marked “Launchpad route only” need an account per wallet (or a payment only Launchpad adds), so the coin trades on Launchpad until it graduates. Rules marked “App only” (FOMO-only, Pump App-only) allow pool trades only when the transaction carries that app’s mark, so Launchpad’s own Buy and Sell are off for the coin until it graduates.',
  'The pool, the creator, Launchpad’s fee wallets and the coin’s own vaults are never blocked by a rule, so trading fees and graduation always settle.',
  'A rule can stop a transfer; it never takes a fee, moves tokens or changes anyone’s balance.',
]);
