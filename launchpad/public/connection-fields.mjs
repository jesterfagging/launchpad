// Connection profiles are account-wide; fees and trade rules remain per run.
export const connectionFields = {
  solana: [
    { key: 'heliusKey', label: 'Helius API key', type: 'secret', group: 'Trading providers', help: 'Optional when using your own RPC. Also authenticates Helius streams.' },
    { key: 'jupiterKey', label: 'Jupiter API key', type: 'secret', group: 'Trading providers', help: 'Your routing allowance. Leave blank to use public routing.' },
    { key: 'rpcUrl', label: 'Custom RPC URL', type: 'secret', group: 'Trading providers', help: 'Complete HTTPS URL, including its API key. Overrides the Helius RPC.' },
    { key: 'rpcRequestsPerSecond', label: 'RPC requests / second', type: 'number', min: 1, max: 1000, group: 'Trading providers', help: 'Set this within your provider’s allowance.' },
    { key: 'streamMode', label: 'Transaction stream', type: 'select', options: [['logs','Standard RPC logs'],['helius','Helius full transaction stream']], group: 'Transaction stream' },
    { key: 'wsUrl', label: 'Custom WebSocket URL', type: 'secret', group: 'Transaction stream', help: 'Optional WSS endpoint. LaserStream requires a compatible paid plan.' },
    { key: 'fastPumpLogs', label: 'Fast Pump logs', type: 'boolean', group: 'Transaction stream', help: 'Read supported Pump/SOL trades from processed logs. Other routes use confirmed transactions.' },
    { key: 'jitoUrl', label: 'Custom Jito URL', type: 'secret', group: 'Advanced endpoints' },
    { key: 'jitoAuth', label: 'Jito authorization', type: 'secret', group: 'Advanced endpoints' },
    { key: 'senderUrl', label: 'Custom Helius Sender URL', type: 'secret', group: 'Advanced endpoints' },
  ],
  robinhood: [
    { key: 'rpcUrl', label: 'Robinhood RPC URL', type: 'secret', group: 'Trading providers', help: 'Complete HTTPS RPC URL for Robinhood mainnet, chain 4663. Clear to use the public endpoint.' },
    { key: 'rpcRequestsPerSecond', label: 'RPC requests / second', type: 'number', min: 1, max: 1000, group: 'Trading providers', help: 'Set this within your provider’s allowance.' },
    { key: 'pollMs', label: 'Target polling interval (ms)', type: 'number', min: 250, max: 30000, group: 'Trading providers', help: 'Lower intervals request new blocks more often; your RPC rate limit still applies.' },
  ],
  market: [
    { key: 'marketRefreshSeconds', label: 'Market refresh', type: 'select', options: [['60','Every minute'],['300','Every 5 minutes'],['0','Manual only']], group: 'DEX Screener · both chains', help: 'Controls Launchpad’s statistics and holder snapshots. The DEX Screener chart updates independently; live swaps request updates each second while visible.' },
    { key: 'blockscoutKey', label: 'Blockscout API key', type: 'secret', group: 'Holders · Robinhood', help: 'Create your own Pro API key (starts with proapi_) using the free tier. This loads Robinhood holders and recent activity. Solana balances use your RPC; recent swaps use your Helius key.', link: 'https://dev.blockscout.com/', linkText: 'Get a free Blockscout key' },
    { key: 'coingeckoKey', label: 'CoinGecko API key', type: 'secret', group: 'Advanced endpoints', help: 'Optional legacy API connection. The DEX Screener viewer does not use this key.', link: 'https://www.coingecko.com/en/developers/dashboard', linkText: 'CoinGecko dashboard' },
    { key: 'coingeckoPlan', label: 'CoinGecko key type', type: 'select', options: [['demo','Demo · free'],['pro','Paid plan']], group: 'Advanced endpoints', help: 'Only applies to the optional legacy CoinGecko API connection.' },
  ],
};
export const connectionTitles = { solana: 'Solana', robinhood: 'Robinhood', market: 'Market data' };
export const connectionKeys = chain => (connectionFields[chain] || []).map(field => field.key);
