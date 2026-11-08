# Robinhood Chain: pool-native launches, the service and the pages

The launchpad on Robinhood Chain: the launch contracts in `contracts/curve-launch-evm` (Solidity, Foundry)
and the venue in the Node host — the worker that runs every launch and option, the launch page's chain choice, the
coin page, Explore's chain switch, My Tokens and the admin tab. This guide covers what the contracts do, how to build,
test and deploy them, and how to switch the venue on and run it.

A Robinhood coin is no longer a bonding-curve contract that graduates into a
pool: it is a **Uniswap v4 pool from its first block**, with the whole supply locked as liquidity, so it trades on
Launchpad, in the Uniswap app, on GMGN, on DexScreener and from any wallet from the moment it exists — nothing to
integrate per platform. The curve is still there: the sell supply sits in one one-sided position between the tier's
start price and the $50k graduation price, which is exactly the virtual-reserve curve (same prices, same raise, same
supply split as Launchpad's Solana launches), and the rest of the supply sits in a second position above graduation.
Graduation is the price crossing the graduation tick: the locker collects the curve pool's last fees and moves the
raise and the unsold supply, by code alone, into the coin's **graduation pool** (a 0.5% pool opened empty at launch,
so no one can set its price), the counterpart of Raydium's migration; trading continues there, on every venue.

## What exists on chain after the deploy

- **LaunchFactory** — the launchpad. `launch()` creates the coin (`LaunchToken`, fixed supply, 18 decimals,
  `contractURI()` / `tokenURI()` pointing at the host's metadata), initializes its Uniswap v4 pool at the start price
  (no hook, tick spacing 10, fee = 1.25% platform + 0.5% creator, or + the holder tax), opens the graduation pool at the
  graduation tick with no liquidity (so its price cannot be front-run), hands the supply to the locker, which mints
  the two positions, installs the coin's transfer rules with the PoolManager as the venue, takes the launch fee
  and makes the creator's first buy through the swap router. Owned by the Launchpad host: launch configs, approved pair
  assets (ETH, USDG, stock tokens…, each with a default curve and the range a custom curve may use), launch fee,
  platform recipient. No owner function can touch a launch's liquidity or fees. A launch chooses its pair asset and
  its curve numbers — the FDV tiers are curve numbers the service computes with `curveForTargets` at the live price.
- **LaunchLocker** — holds every coin's positions for good: no function hands liquidity to anyone and the
  contract has no owner (a v4 position belongs to the contract that added it, and only `lockLaunch`, callable by the
  factory alone, ever adds one). `collect(token)` takes the pool's accrued fees into the escrow split (coin-side fees
  are sold into the pool in the same call, so everything arrives in the pair asset); `graduate(token)` runs the
  migration once the price has crossed the tick (anyone may call it; the service does): it collects the curve pool's
  fees, removes both positions, brings the graduation pool to the curve pool's price (an empty pool's price moves for
  free; foreign liquidity, if someone added some, is swapped against), adds one full-range position with everything
  the two positions held plus one-sided slivers for the rounding leftovers, burns the coin dust and credits the quote
  dust to the fees, then tells the factory. `progressBps(token)` and `crossed(token)` read the curve's progress off the
  pool (10000 / true once graduated); `poolKeyOf(token)` is the pool trading now.
- **LaunchSwapRouter** — the site's own way in and out of a pool: `buy` (exact pair-asset input, ETH as value or an
  ERC-20 pulled from the caller) and `sell` (exact coin input; approve the router once), both with a minimum output
  and a deadline, settled straight between the trader and the PoolManager. A convenience, not a requirement: any
  router, aggregator or wallet trades the same pool the same way. No owner, holds nothing between calls.
- **LaunchFeeEscrow** — where every fee lands, claimable by its recipient at any time: the platform share of the pool
  fees and the launch fees under the platform recipient (the Launchpad treasury); the creator share under the coin's
  creator fee recipient (the creator's wallet, or a Launchpad per-coin wallet for the reward options). No owner.
- **LaunchRuleEngine** — the transfer rules (23 of the 27 Solana rules, same kinds, same parameters), active until
  graduation. The venue is the PoolManager: a buy from *any* venue is a transfer out of the pool, a sell a transfer
  into it, so the rules hold on Uniswap and GMGN exactly as on Launchpad (a refused buy reverts the swap).
- **LaunchPayouts** — batch ETH / ERC-20 payouts for the reward options; **LaunchTokenDeployer** — the CREATE2 deployer
  behind `predictToken`.

Fees (Raydium's shape — `LAUNCHPAD_RH_*_FEE_BPS` at deploy time, the owner's to change per config): the curve pool
charges **1.75%** for a Creator / Earned / Insured coin — 1.25% platform (the 1% protocol fee plus the 0.25% a Raydium
launch pays Raydium) and a flat 0.5% creator fee — and the graduation pool **0.5%** (0.25% platform / 0.25%
creator). A Holders / Diamond Hands coin carries no creator fee; a **holder tax of 1–3%** (2% unless the creator
chooses, `taxBps` on the launch) is added to both pools' fees in its place, 95% of it to the holders' wallet and 5%
to the platform — so a 2% tax coin is a 3.25% curve pool and a 2.5% graduation pool. The launch records a platform
share per stage (`curveShareBps` 7142 / `poolShareBps` 5000 for the creator shape; 4153 / 1400 at a 2% tax) and the
escrow splits every collection by the share of the stage the fees came from. Launch fee 0.001 ETH. Fees accrue to
the locked positions and are collected by the service into the escrow — before and after graduation, from every
venue's trades.

Pair options and tiers: the pool is paired with native ETH when the launch names the zero address, otherwise with
any ERC-20 the owner approved — USDG, a tokenised stock (NVDAon, TSLAon…), cbBTC. ETH is always currency0 (the
coin is currency1 and the pool quotes coins per ETH, falling as the coin is bought); an ERC-20 pair may be either
orientation and the contracts and the service handle both. The tier is chosen per launch and the tiers are Solana's:
a **$4k start graduating at $50k** and a **$20k start graduating at $50k**. The supply is a billion either way; the
tier decides the split — the $4k tier puts 78% in the curve position and 22% above it (virtual $4,348, raise
$11,024), the $20k tier 61% and 39% (virtual $33,333, raise $19,371). The service converts the tier into the pair
asset at the live price with `curveForTargets(startFdv, graduationFdv)` and passes the numbers with the launch; the
on-chain defaults (the $20k tier at the deploy-time price) only serve a launch that passes none. The start and
graduation prices round to the tick spacing, so a raise lands within about 0.1% of the tier's number.

## Pair logos

Robinhood's API names a logo per stock token, but every one is the same Robinhood token mark, so the host
looks a stock's or ETF's mark up by ISIN, then by ticker, on public logo services — Parqet
(`assets.parqet.com/logos/isin/<ISIN>`, `/logos/symbol/<TICKER>`), then EODHD (`eodhd.com/img/logos/US/<TICKER>.png`)
— and takes Robinhood's image only when neither answers; ETH takes Parqet's crypto mark; USDG has none (a
lettermark). The first source that answers is cached under `<accounts dir>/robinhood-logos/v2/` for a week and served
from `/robinhood-pairs/logo/<address>?v=2`; a miss is retried after ten minutes. A file dropped into
`<accounts dir>/robinhood-logos/overrides/<address>.(png|jpg|webp|svg)` wins for that pair (USDG, a custom token, a
stock whose mark you prefer).

## Your deployment

The deploy step below prints the contract addresses. Put six of them in the host settings (`LAUNCHPAD_RH_LAUNCH_FACTORY`,
`LAUNCHPAD_RH_FEE_ESCROW`, `LAUNCHPAD_RH_LAUNCH_LOCKER`, `LAUNCHPAD_RH_RULE_ENGINE`, `LAUNCHPAD_RH_SWAP_ROUTER`,
`LAUNCHPAD_RH_PAYOUTS`; see `deploy/launchpad-robinhood.env.example`), then launch a small test coin, trade it, collect
its fees and graduate it before you open launches to the public.

## Build and test

Install Foundry (https://getfoundry.sh, then `foundryup`). The tests run against the **real Uniswap v4 PoolManager**,
whose sources are not part of this tree: put them in place once per checkout (needs `git` and the network, or pass the
path of a v4-core checkout or an extracted `main.zip`), then build and test:

    cd contracts/curve-launch-evm
    node scripts/vendor-v4-core.mjs
    forge build
    forge test --evm-version cancun

The commands below use `export NAME=value`; on Windows use `set NAME=value` instead.

`foundry.toml` sets Cancun for the whole tree (the vendored PoolManager uses transient storage, which forge only
activates from Cancun on and which Robinhood Chain supports); `--evm-version cancun` on a command line is accepted and
changes nothing. The suites: the launch flow (coin, pool and
positions from one call; the dev buy; buys following the curve within 2% of the virtual-reserve maths and sells
paying back; the router's guards; fees collected and split; graduation at the tick; both pool orientations on a USDG
pair; custom tiers and their bounds; the owner's configuration; nothing removes liquidity; a fuzz of trades keeping
the books), every rule accepted and refused through the pool, the payouts contract, and the libraries (the calendar
and oscillator ports against the Solana program's values, the v4 tick arithmetic against Uniswap's constants).

## Deploy (when you decide to go live)

1. Verify the Uniswap v4 PoolManager address the script defaults to on https://robinhoodchain.blockscout.com — it
   is the one `src/robinhood-contracts.mjs` recorded from the official deployment registry:
   `0x8366a39cc670b4001a1121b8f6a443a643e40951` (USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`). If either
   differs, pass the right one in the environment (`LAUNCHPAD_RH_POOL_MANAGER`, `LAUNCHPAD_RH_USDG`).
2. Pass ETH's price: `export LAUNCHPAD_RH_ETH_USD_CENTS=<price in cents, e.g. 400000 for $4,000>`. The script expresses the
   default tier ($20k → $50k; `LAUNCHPAD_RH_TIER_START_USD` / `LAUNCHPAD_RH_TIER_GRADUATION_USD` to change it) in ETH at that
   price and in USDG exactly, and allows custom raises from 5% to 10× of it (`LAUNCHPAD_RH_CUSTOM_MIN_BPS` /
   `LAUNCHPAD_RH_CUSTOM_MAX_BPS`) with a steepness of 0.2 – 10 (`LAUNCHPAD_RH_MIN_RATIO_BPS` / `LAUNCHPAD_RH_MAX_RATIO_BPS`) —
   room for the $4k tier at any ETH price within a few multiples of today's. Other pair assets (stock tokens, cbBTC)
   are one `setPairAsset` call each, by the owner, after the deploy.
3. Deploy from a funded wallet (the seven contracts and the configuration). Store the deployer key in Foundry's
   encrypted keystore once (`cast wallet import deployer --interactive`) rather than typing it on a command line:

       export LAUNCHPAD_RH_PLATFORM_RECIPIENT=0x<your treasury>
       export LAUNCHPAD_RH_ETH_USD_CENTS=400000
       forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --account deployer --evm-version cancun

   The script prints the addresses (escrow, factory, locker, engine, token deployer, **router** and payouts). Keep
   them: the host reads them from `/etc/launchpad.env` (`LAUNCHPAD_RH_LAUNCH_FACTORY`, `LAUNCHPAD_RH_FEE_ESCROW`,
   `LAUNCHPAD_RH_LAUNCH_LOCKER`, `LAUNCHPAD_RH_RULE_ENGINE`, `LAUNCHPAD_RH_SWAP_ROUTER`, `LAUNCHPAD_RH_PAYOUTS`; the PoolManager in
   `LAUNCHPAD_RH_POOL_MANAGER` when it is not the default).
4. Verify the source on Blockscout (`forge verify-contract … --verifier blockscout --verifier-url
   https://robinhoodchain.blockscout.com/api`) so creators can read the code their coin runs on.
5. Make one launch yourself before opening it to anyone — `script/SmokeLaunch.s.sol` does it for pennies while the
   deployer still owns the factory (a tiny ETH coin, a buy and a sell through the router, the fees collected into the
   escrow, the curve position filled, the graduation run into the 0.5% pool and one more trade there; the locker's
   positions checked):

       export LAUNCHPAD_RH_FACTORY=0x<factory>
       forge script script/SmokeLaunch.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --account deployer --evm-version cancun

   The smoke coin is a real pool: open it in the Uniswap app and on GMGN / DexScreener afterwards to confirm the
   third-party routes (the links the coin page shows) before any creator relies on them. Then `setLaunchesOpen(false)`
   until the service is there to run the reward modes, or keep it open for hand-made launches.

Do not open public launches before an audit: the contracts hold user funds.

## What is Solana-only and why

- The two app-only rules (FOMO-only, Pump App-only), the sniper-fee cap and the tithe: they read Solana transaction
  details (co-signers, priority fees, Jito tips) or ride on an instruction only Launchpad's own Solana route adds; a
  Uniswap v4 swap carries neither.
- Meteora's locked-LP fee policies and the DAMM pools: Robinhood coins *are* Uniswap v4 pools, with the same
  locked-liquidity-plus-fee-claims model from the first block.
- Token-2022 transfer taxes: the holder tax in the pool fee is the equivalent, on every venue's trades.

## Switching the venue on

The host side needs the deployed contracts, the master switch and a little ETH on two wallets it makes for itself.

1. **Environment.** Append `deploy/launchpad-robinhood.env.example` to `/etc/launchpad.env` with the contract addresses the
   deploy script printed (`LAUNCHPAD_RH_LAUNCH_FACTORY`, `LAUNCHPAD_RH_FEE_ESCROW`, `LAUNCHPAD_RH_LAUNCH_LOCKER`,
   `LAUNCHPAD_RH_RULE_ENGINE`, `LAUNCHPAD_RH_SWAP_ROUTER`, `LAUNCHPAD_RH_PAYOUTS`), the treasury address the platform share is
   swept to (`LAUNCHPAD_RH_TREASURY`) and `LAUNCHPAD_ROBINHOOD_LAUNCH_ENABLED=1`. Restart launchpad. Without the switch every
   Robinhood route answers 503 and the launch page offers Solana only; nothing else changes.
2. **Readiness.** `node scripts/check-robinhood.mjs /etc/launchpad.env --pairs` reads the configuration, the chain, the
   factory (including that its router and locker are the ones in the environment), the pairs and the prices, and
   says what one launch on each tier would cost. It signs and sends nothing.
   **The RPC.** Robinhood's public endpoint is rate-limited and meant for wallets and testing; it blocks a host that
   scans logs for many coins (HTTP 403). Before opening intake, put a dedicated endpoint in `LAUNCHPAD_RH_RPC_URL`
   (Chainstack's Growth plan — $49/month, 250 requests/second, archive — or Alchemy pay-as-you-go; the host needs
   `eth_getLogs`) and set `LAUNCHPAD_RH_RPC_RPS` to a margin under the provider's ceiling (100 to 200 on Growth).
3. **Host wallets.** On first start the service makes two EVM wallets in the encrypted host store: the *owner*
   wallet (owner transactions on the factory, graduation records) and the *platform* wallet (claims the platform
   share from the escrow, sweeps it to the treasury). Admin → Tokens → Robinhood Chain shows both; send each a
   little ETH (0.05 ETH is plenty for months at Robinhood Chain's gas prices).
4. **Hand the factory over.** From the deployer wallet call `transferOwnership(<host owner wallet>)` on the factory
   (`cast send` or Blockscout's write tab), then in the admin tab use **Accept factory ownership**, then **Set
   platform recipient to the host wallet**. From then on every owner action (open or close launches, the launch
   fee, pair approvals) is a button in that tab, each needing a reason and your password and 2FA code.
5. **Pairs.** ETH and USDG are approved by the deploy. **Sync pairs** reads Robinhood's stock-token list; each stock
   or ETF shows **Approve on chain** (one owner transaction, the $20k tier at today's price with a 5% – 10× range)
   and **Offer to creators**. The `pairs` flag opens the stocks, ETFs and custom pairs to everyone; while it is off
   only you see them on the launch page (owner preview).
   **Custom pairs.** *Add a pair by token address* lists any ERC-20 on the chain that a Uniswap pool prices against
   USDG or ETH (the token is read on the chain: symbol, name, decimals, supply; more than 18 decimals is refused).
   Adding is a listing: approve it on chain and offer it to creators as for a stock. Creators find the same check on
   the launch page (Custom → paste an address): a compatible token they ask for appears under *Requested by
   creators* with **Add pair** / **Dismiss**. **Remove** takes a custom pair off the list (the chain's approval stays
   as it is; `setPairAsset` from the admin tools changes it).
6. **Flags.** `intake` (new quotes), `pairs`, `collection` (escrow claims and pool-fee collection), `routing`
   (sweeps) and `holders` (payouts) start with intake and pairs off. Turn intake on when the audit is done.

### How a launch runs

The creator connects an EVM wallet on the launch page (the dialog adds Robinhood Chain to the wallet when it is
missing), reviews a quote and sends one transfer — the launch fee, the first buy (in ETH, or the pair asset in a
second transfer), a gas budget and, for an option that runs from a Launchpad wallet, that wallet's gas — to a launch
wallet the service made for that coin. The worker confirms the funding by balance (and checks the hashes the page
sent), calls `launch()` from the launch wallet with the creator recorded as the coin's creator and the first buy
delivered straight to the creator's wallet, then refunds the unused budget. The coin's page trades through the swap
router from the creator's or anyone's wallet, and links to the same pool on Uniswap, GMGN and DexScreener. The worker
reads each coin's pool state every pass (price, tick, liquidity, positions, progress), follows the PoolManager's `Swap`
logs for the coin's pools — the curve pool and, once graduated, the graduation pool — together with the coin's
`Transfer` logs (every venue's trades land in the journal and the holder index, attributed to the wallet that received
or sent the coins in that transaction; the migration's own price-setting swap is not a trade), runs the graduation
(`locker.graduate`, from the owner wallet, with the policy's `graduateGas`) when the price has crossed the tick and
switches the coin's tracked pool to the graduation pool (`pool_id`; the curve pool stays in `curve_pool_id`),
collects the pool's fees into the
escrow hourly once they are worth the collection minimum, claims the creator share from the escrow to the coin's fee
wallet (Holders, Diamond Hands, Earned and Insured; a Creator coin's share stays under the creator's own wallet in
the escrow, claimed from the coin page), samples holders every five minutes, pays the top 100 through `LaunchPayouts`
when their share reaches the threshold (`LAUNCHPAD_RH_HOLDER_PAYOUT_USD`, default $100), and runs Earned's daily record
and Insured's deadline. The platform wallet claims the platform share every 15 minutes once it is worth $20 and
sweeps to the treasury.

Every money move is journaled before it is sent (`<data dir>/robinhood-launch/robinhood-launch.sqlite`; back it
up with the data folder and never restore an older copy over a newer one). A stalled transaction is re-sent after 30 s and replaced with
higher fees after ten minutes; a launch that reverts is retried up to three times, then failed and refunded; a quote
expires unfunded after ten minutes. **Back up the database** and **Verify stored keys** are in the admin tab.

### What to watch

- The admin tab's status line: the worker's last pass, its last error, the database integrity.
- Both host wallets' ETH (the tab warns under 0.001 ETH): the owner wallet pays graduation records and owner
  transactions, the platform wallet pays its claims and sweeps.
- A coin whose fee wallet is out of gas (an event on the launch: "Fee wallet is out of gas"): send it a little ETH.
- Pairs whose price Robinhood reports as halted: the launch page refuses quotes on them until trading resumes.
- A coin past its graduation tick that the worker has not recorded (the admin row offers **Record graduation**):
  the owner wallet may be out of ETH.

### Pair badges

The pair catalogue shows each stock's or ETF's own mark in a circular badge, as Solana's picker does. Robinhood
publishes a logo for every tokenized stock; the browser only loads images from this host, so the host fetches each
logo once (when a creator first opens the catalogue), keeps it for a week under `<data dir>/robinhood-logos/` and
serves it from `/robinhood-pairs/logo/<address>`. A pair without a published logo (USDG, a Launchpad-added token) shows a
two-letter lettermark, ETH the ether glyph. To give one its own mark, drop a file named after the pair's address into
`<data dir>/robinhood-logos/overrides/` — `0x0000000000000000000000000000000000000000.png` for ETH,
`<USDG address>.svg` for USDG, and so on (`.png`, `.jpg`, `.webp` or `.svg`, under 512 KB; the folder is re-read
within a minute). An override is served for that pair even when a published logo exists.

### What aggregators read

A coin's metadata is published at `/token-metadata/<token address>.json` (ERC-7572 `contractURI()` / ERC-1046
`tokenURI()` shape with `name`, `symbol`, `description`, `image`, `external_link`, `website`, `twitter`, `telegram`,
plus the Solana `extensions` block). GMGN, DEXTools and the explorer read that JSON from the token's `contractURI()`.
The pool itself needs no listing: DexScreener and GMGN index Uniswap v4 pools on Robinhood Chain from the
PoolManager's events, and the Uniswap app routes to any hookless pool. The links the coin page shows
(`robinhoodTradeLinks` in `public/robinhood-launch-catalog.mjs`) are the platforms' token URLs; confirm each on the
smoke coin and adjust the patterns there if a platform changes its URL scheme.

### Explore

The home page's **All | Solana | Robinhood** switch filters the feed by chain (remembered per browser, `?chain=` in
links). Robinhood coins come from the venue service's journal — price and market cap from the last pool reading,
the day's volume and buys from the trades, holders from the index — and render with the pool badge, their pair's
badge and a link to their own coin page; the featured coin's chart is the pool's price after each recorded swap.
