# Launchpad launch contracts for Robinhood Chain

The launchpad's own launch contracts on Robinhood Chain (chain 4663, an Arbitrum Orbit chain, gas in ETH): the Solana
launch experience rebuilt in Solidity, standalone, with no third-party launchpad in the loop. One factory call creates a
coin and its Uniswap v4 pool, with the bonding curve as a concentrated position; trades pay a fee that is split on chain
between the platform and the coin's creator fee recipient; at graduation the liquidity moves into a full-range Uniswap
v4 position held by the locker contract, which keeps paying LP fees into the same split; and the coin's transfer rules —
the transfer hook catalogue of the Meteora launches — run inside the token itself until graduation. A launch picks its
pair asset (ETH, USDG, a tokenised stock — whatever the host approves) and its FDV tier — a $4k start or a $20k start,
both graduating at $50k, as on the Solana launches (the host's curve numbers, or its own inside the host's bounds).

Everything here is self-contained: no `forge install`, no npm, no submodules. The ERC-20, ownership, reentrancy guard,
safe transfers, full-precision math, the Uniswap v4 interfaces (`IPoolManager`, the unlock callback, `PoolKey`) and the
v4 arithmetic (TickMath, liquidity from amounts, the slot0 read through `extsload`) are in `src/lib` and
`src/interfaces`.

## Contracts

| Contract | What it is |
| --- | --- |
| `LaunchFactory` | The entry point and the only owned contract. `launch()` creates the coin (CREATE2, vanity salts), its Uniswap v4 pool and its liquidity, installs the coin's rules and makes the creator's first buy. The whole supply goes into the pool at once as two one-sided positions held by the locker: the sell supply between the tier's start price and its graduation price (the bonding curve as a concentrated range) and the rest above the graduation price. The pool is a plain v4 pool with no hook, so any router or wallet can trade it. The owner (the host) sets launch configs (total supply, fee split, tick spacing, the allowed curve steepness), approved pair assets (each with a default curve and the raise range a custom curve may use), the launch fee and the platform recipient; it can never move a launch's liquidity or change a launched coin's rules. `curveForTargets(startFdv, graduationFdv)` turns an FDV tier into curve numbers; `fdvFor` shows what a pair of numbers means; `plannedSupply` shows how the tier splits the supply. |
| `LaunchTokenDeployer` | Creates each coin with CREATE2 for the factory (kept separate so the factory stays under the 24 KB size limit); `predict` gives the address for a salt. |
| `LaunchToken` | The coin: a fixed-supply 18-decimal ERC-20 minted once to the factory. Every transfer consults the rule engine while `rulesActive`; the factory switches that off at graduation. `burn` for buyback-and-burn. |
| `LaunchRuleEngine` | A singleton holding every coin's rule configuration and state: 24 of the Solana program's 27 rules with the same kinds and six parameters (`hookRuleParams` in `public/hook-catalog.mjs` packs both). The venue is the curve; the pool manager, the factory, the locker, the platform recipient, the creator and the creator fee recipient are exempt. |
| `LaunchFeeEscrow` | A pull-based ledger with no owner: credits in ETH or any ERC-20, claimed by the recipient to any address. The platform's revenue and every coin's creator share live here until claimed. |
| `LaunchLocker` | Holds every coin's v4 liquidity. When the price crosses the graduation tick, anyone can call `graduate`, which moves everything the curve pool's positions hold into the graduation pool as one full-range position. There is no function that sends liquidity or assets to an address, no owner and no upgrade path; anyone can `collect(token)` to move the LP fees into the escrow split. |
| `LaunchSwapRouter` | The site's own way in and out of a coin's pool: exact-input buys and sells with a minimum output and a deadline, settled between the trader and the PoolManager. It holds nothing between calls and has no owner. |
| `LaunchPayouts` | Pays many holders in one transaction, in ETH or an ERC-20; a recipient that cannot be paid is skipped and reported. Stateless and ownerless. |

### Fees

With the defaults in `script/Deploy.s.sol`: a 1% trade fee on the curve, 30% of it to the platform and 70% to the
creator fee recipient; an optional creator tax of up to 10% paid to the creator fee recipient in full; a launch fee in
ETH to the platform; an optional migration fee (a share of the raised quote) to the platform at graduation; and after
graduation the pool's 1% LP fees, collected by the locker and split 30/70 the same way. The creator fee recipient is
whatever address the launch names — on Launchpad a per-coin wallet the service runs the reward modes from (holders, buyback
and burn, Gotchi, agents, Diamond Hands / Earned / Insured, baskets) — and it can hand the role on
(`transferCreatorFeeRecipient`). The platform recipient is the host's treasury and is rotated by the owner.

### The curve, pair options and FDV tiers

A config names the total supply `N` (1 billion by default) and the fee split; the curve itself is two numbers in the
pair asset, the virtual quote `Vq` and the graduation quote `R`. Each approved pair asset carries a default pair, and
a launch may bring its own inside the owner's bounds (the pair asset's raise range, the config's steepness range
`R / Vq`). As on Launchpad's Solana launches the supply is fixed and the tier decides the split: the pool share is
`L = N × Vq / (2 Vq + R)`, the curve sells `S = N − L`, and `Vt = S × (Vq + R) / R`, so the pool opens at exactly the
curve's final price (Pump.fun's 30 : 85 shape gives its 793 M / 207 M). Buys and sells are `k = Vq × Vt`
constant-product trades on the quote net of fees; the buy that completes the raise takes every sellable token and
refunds the rest of its quote.

The start FDV is `Vq × R × (2 Vq + R) / (Vq + R)²` and the graduation FDV is `(1 + R / Vq)²` times that, so a tier
is a pair of FDVs: `curveForTargets(startFdv, graduationFdv)` (both in the pair asset) returns the `Vq` and `R` that
hit them — the Launchpad service converts the tier into ETH or USDG at the live price and passes the numbers with the
launch. Launchpad's two tiers are Solana's: a **$4k start → $50k graduation** (virtual $4,348, raise $11,024, 78% of the
supply sold on the curve, 22% opens the pool) and a **$20k start → $50k graduation** (virtual $33,333, raise $19,371,
61% sold, 39% to the pool). The $20k tier is the on-chain default for a launch that passes no numbers.

Pair options: the pool is native-ETH-paired when `pairToken` is the zero address (v4 trades ETH without WETH) and
ERC-20-paired otherwise — USDG, a tokenised stock, cbBTC, anything the owner approves with `setPairAsset`. Fees, the
escrow, the curve maths and the locker all work in that asset; a `tithe` donation is always ETH.

### Graduation (Uniswap v4)

The pool (`PoolKey{currency0, currency1, fee, tickSpacing, hooks = 0}`, native ETH as currency zero) is initialized
in the pool manager in the launch transaction at the graduation price, so nobody can seed it at a foreign price in
between; a pool that already exists at another price stops the launch (pick another salt). At graduation the curve
reads the pool's price from the manager's storage (`extsload` of slot0) and checks it against its own: within the
tolerance it goes straight on; otherwise it swaps up to 2% of the raised quote or of the pool tokens through
`unlock` / `swap` to move the price back (the pool manager is rule-exempt, so this runs before the rules are switched
off). If that budget is not enough the graduation is deferred — the curve is full, the trade that filled it still
lands, and `graduate()` can be retried by anyone, or `forceGraduate` by the factory owner with up to a 20% budget.
Then the curve hands everything it holds to the locker, which computes the liquidity both amounts fund at the current
price, adds it full-range under its own address (`modifyLiquidity`, settled with `settle` / `sync` + transfer) and
returns what the price could not use; the curve burns the leftover coin and credits the leftover quote to the creator
fee recipient. `collect` is a liquidity change of zero that returns the fees accrued, taken with `take`.

### Rules

Kinds 1–20 and 22–25 of the catalogue. `dex_only` means "moved by a contract" (a router, the curve); `anti_bundle`
counts trades per L2 block (ArbSys); `holder_vesting` needs no wallet registration; `tithe` is taken by the curve in
ETH with every trade by a non-exempt wallet. `sniper_fee_cap` (21) and the two app-only rules (26, 27) are Solana
things and are refused at install. Rules run only until graduation; the token is a plain ERC-20 afterwards.

## Build and test

Foundry (any 1.x) and solc 0.8.28. The project has no dependencies to install.

    forge build
    forge test

Offline (no compiler download): put a `solc-static-linux` binary somewhere and set `FOUNDRY_SOLC=/path/solc`
(`FOUNDRY_OFFLINE=true` stops forge from trying the network). 70 tests: the launch flow with a mock v4 pool manager
(`test/Launch.t.sol` — the real unlock / delta / settle accounting, constant-product swaps with the LP fee, slot0
through `extsload`; includes a fuzzed invariant run, a stock-token pair, FDV tiers and their bounds), every rule
accepted and refused (`test/Rules.t.sol`), and the library ports against the Solana program's own test values plus
the v4 arithmetic against Uniswap's TickMath constants (`test/Libraries.t.sol`).

## Deploy

    export LAUNCHPAD_RH_PLATFORM_RECIPIENT=0x...   # the treasury that claims the platform share
    export LAUNCHPAD_RH_ETH_USD_CENTS=400000       # ETH's price in cents today, for the default ETH curve
    forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --account deployer

The script deploys the escrow, factory, locker and engine against the chain's v4 PoolManager, sets the ETH config (a
billion supply; the default curve is the $20k → $50k tier in ETH at the price you pass in `LAUNCHPAD_RH_ETH_USD_CENTS`;
custom raises from 5% to 10× of it, steepness 0.2–10), approves USDG as a pair asset with the same tier in dollars,
sets the launch fee and opens launches. Further pair assets (stock tokens, cbBTC) are one `setPairAsset` each.
`docs/ROBINHOOD.md` in the repository root has the full guide, the settings the Launchpad host reads, and what
to verify on the explorer before the first real launch.

## Trust assumptions

The factory owner (the Launchpad host) can change the fee split and pair assets for *future* launches, rotate the
platform recipient, close launches, and force a deferred graduation with an alignment budget of up to 20% of the
raised quote or the pool tokens. That last power is the only one that can cost a launch anything, and only when the
pool's price was moved away from the curve's in the first place; the host should use it with care. The creator fee
recipient trusts whoever holds that address (on Launchpad, the host's per-coin wallet). Nothing else is privileged.

## Not audited

These contracts hold user funds. They have been built and tested against a mock v4 pool manager here and must be
exercised on a fork of Robinhood Chain (`forge test --fork-url ...` against the real PoolManager at
`0x8366a39cc670b4001a1121b8f6a443a643e40951`) and audited before real launches are opened to the public.
