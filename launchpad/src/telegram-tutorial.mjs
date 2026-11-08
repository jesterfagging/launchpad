export function showTutorial(bot, ctx) {
  ctx.prompt = null; ctx.manualDraft = null; ctx.navigation++;
  return bot.say(ctx, `Launchpad setup tutorial

SOLANA
1. Open Helius below, create an account and API key, then copy its Solana mainnet HTTPS RPC URL.
2. Open Account → Connections → Solana and paste the complete URL into Custom RPC URL. The separate Helius API key field takes only the key; a custom URL overrides it.
3. Open Jupiter below, create or join a team and generate a key. Enable Swap and Price access if permissions are offered. Save it as Jupiter API key.
4. Standard RPC logs uses an ordinary RPC WebSocket endpoint. Helius full transaction streaming is optional and needs the appropriate Helius service access.

ROBINHOOD
1. Open Alchemy, create an app for Robinhood Chain Mainnet (4663), and copy its complete HTTPS RPC URL.
2. Save that URL in Account → Connections → Robinhood. Helius/Jupiter/Jito credentials are not needed on this chain.
3. Fund your selected trading wallets with Robinhood ETH and keep extra ETH for gas. Copy, Sniping, Market Making and Liquidity all use ETH amounts. Launchpad discovers pools and handles conversions automatically. You do not need to buy quote tokens or enter a conversion pool.

FIRST RUN
Choose a tool, select its wallets, and set target/developer addresses or a token. Enter an ETH amount or budget on Robinhood, or a SOL amount on Solana. Review the settings, then Start. The Account cashback wallet is separate from trading wallets.
For LP fees, open Positions → Claim fees to return earnings to the wallet while keeping the position open. Enable Auto-compound fees in Pair & budget to reinvest earnings while the LP tool runs. Some pools already retain fees in their reserves; those have no separate claim.
Wallet keys are encrypted and stored on Launchpad’s server for automated signing. Keep private backups and don’t share keys or full setup exports in group chats. You do not need a BotFather token to use Launchpad.

401/403: check the saved URL/key and provider restrictions. Requests use the Launchpad server’s IP. “Saved” does not mean validated.
429: check provider quotas and lower requests per second or simultaneous activity.
After changing a connection, Stop and start a fresh run.`, [
    [{ text: 'Helius dashboard', url: 'https://dashboard.helius.dev' }, { text: 'Helius guide', url: 'https://www.helius.dev/docs/quickstart' }],
    [{ text: 'Jupiter API portal', url: 'https://developers.jup.ag/portal' }, { text: 'Jupiter guide', url: 'https://developers.jup.ag/docs/portal/setup' }],
    [{ text: 'Alchemy dashboard', url: 'https://dashboard.alchemy.com/' }, { text: 'Robinhood RPC guide', url: 'https://docs.robinhood.com/chain/connecting/' }],
    [{ text: 'Robinhood token contracts', url: 'https://docs.robinhood.com/chain/contracts/' }, { text: 'Fund Robinhood wallets', url: 'https://docs.robinhood.com/chain/bridging/' }],
    [bot.homeButton(ctx)],
  ]);
}
