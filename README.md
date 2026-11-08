# Launchpad

An open-source token launchpad for Solana and Robinhood Chain. People connect their own wallet, launch a coin in one
review, and trade it on a bonding curve until it graduates to a DEX pool. The platform earns a share of trading fees;
creators choose how their coin's fees are used. Everything runs as one Node.js service you host yourself.

It ships as a neutral template: it is called "Launchpad" with a placeholder logo, and one setting gives it your name.

## What it does

**Venues.** Raydium LaunchLab, Meteora Dynamic Bonding Curve, Pump.fun (classic and PumpSwap), an optional PumpSwap
mode on your own Solana program, and Robinhood Chain (Uniswap v4 pools from the first block, contracts included).

**Launch modes** (what a coin does with its creator fees and transfer tax):

| Mode | What it does |
|---|---|
| Creator | Fees go to the creator's wallet. |
| Holders | A transfer tax and fees are paid out to holders, in SOL or in the pair asset. |
| Paycheck | Raydium only: the creator fee is paid out every 15 minutes to holders, a buy-and-burn of your platform token, the platform and the creator. Offered when `LAUNCHPAD_TOKEN_MINT` is set. |
| Gotchi | Coins race for a shared prize pot that buys the winner and airdrops it to its top holders. |
| AI Agent | An AI agent runs the coin's programs and social posts with a budget from its fees (needs its own keys, `deploy/launchpad-agents.env.example`). |
| Market Maker, Liquidity Manager, Diamond Hands, Earned, Insured | Pump.fun programs for liquidity, holder loyalty and refunds. |

Raydium and Meteora coins start at a $20,000 market cap and graduate at about $50,000 (a white-label launchpad can
also offer a $4,000 start). Meteora coins can carry transfer-hook rules (anti-sniper fees, holder vesting, allowlists,
holder-gated trading and more).

**Pages.** Explore (new, moving and graduated coins, search, filters), the coin page (chart, trades, holders, rewards,
buy and sell), Launch, My Tokens, profiles, public Analytics, Docs, Terms and Privacy. Every visitor uses their own
wallet; there are no custodial user balances.

**Admin panel.** Launch policy, fees and revenue, the protocol treasury, gas wallets, vanity mints, custom pairs,
Gotchi and AI Agent controls, volume and revenue reports, and branding, behind two-factor sign-in.

**White-label mode.** One setting turns a host into somebody else's launchpad: their name, logo, colours, layout,
venues and launch modes, with an optional share of its revenue paid to you. See [docs/WHITE-LABEL.md](docs/WHITE-LABEL.md).

**Your own token (optional).** Point `LAUNCHPAD_TOKEN_MINT` at your token and the header shows its price, the treasury
buys it back and burns it with half of the platform's revenue, and Analytics charts the burns.

## Quick start (local)

You need Node.js 22.12 or newer and a Solana mainnet RPC.

```bash
npm ci
cp .env.example .env            # then edit it
set -a; . ./.env; set +a        # load the settings into this shell
npm start                        # http://127.0.0.1:8787
```

To run it for the public, follow [docs/SETUP.md](docs/SETUP.md): a VPS, a domain, HTTPS with Caddy, the systemd
service and the first admin account, step by step.

## Make it yours

- **Name**: `LAUNCHPAD_BRAND_NAME=Your Name` renames every page, message and the onchain platform attribution.
- **Logo**: replace `public/brand-icon.svg`, `brand-icon.png`, `brand-logo.svg`, `brand-avatar.png`, `brand-avatar.jpg`,
  `favicon.ico` and `apple-touch-icon.png`.
- **Links**: `LAUNCHPAD_X_URL` adds your X profile to the footer.
- **Legal pages**: `public/terms.html` and `public/privacy.html` are templates. Have them reviewed for your country, and
  add your contact details and effective date before you open the site.
- **Fees**: the platform fee and launch fees are set in the admin panel (Admin → Fee collection).
- **Analytics start day**: `public/analytics-dates.mjs` holds the first day the daily analytics charts cover. Set it
  to the day your site opens.
- **Your token**: `LAUNCHPAD_TOKEN_MINT` and `LAUNCHPAD_TOKEN_SYMBOL` (see `.env.example`).

All settings are listed with comments in [.env.example](.env.example); optional modes have their own files in
`deploy/`.

## Project layout

| Path | What it is |
|---|---|
| `src/` | The Node service: accounts, launches, venues, trading, rewards, treasury, admin APIs |
| `public/` | The website: pages, styles and browser modules (no build step) |
| `contracts/` | Solana programs (Rust) and Robinhood Chain contracts (Solidity), see [docs/PROGRAMS.md](docs/PROGRAMS.md) |
| `scripts/` | Setup and readiness commands (owner account, treasury and gas wallets, RPC checks) |
| `deploy/` | The systemd unit and example settings for optional modes |
| `test/` | `node:test` suites and fixtures |
| `preview/` | A local preview server with mock data for working on the pages |
| `docs/` | Setup, white-label, Robinhood Chain and program guides |

## Tests

```bash
npm test
```

Some suites need files that are not in the repository (your own program builds, captured third-party program
binaries); they are skipped when those files are missing. See [docs/TESTING.md](docs/TESTING.md).

## Security

The service holds encrypted keys for the wallets it operates (launch wallets, the treasury, gas wallets). Keep the
data folder and the settings file private, back them up, and read [SECURITY.md](SECURITY.md) before going live.
Launching and trading tokens can be regulated where you or your users live; check before you open a public site.

## License

MIT, see [LICENSE](LICENSE). Fonts, vendored libraries and token logos keep their own licenses, see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
