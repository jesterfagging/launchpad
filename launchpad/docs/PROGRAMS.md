# Programs and contracts

The launchpad runs without any onchain program of its own. Raydium LaunchLab, Meteora's Dynamic Bonding Curve,
Pump.fun and PumpSwap are their owners' programs, already on Solana mainnet. The programs in `contracts/` are for
optional features. Each folder has its own README with the full design; this page says what each one is for and how
to make it yours.

| Folder | Chain | What it is | Needed for |
|---|---|---|---|
| `contracts/curve-transfer-hook` | Solana | Token-2022 transfer hook that enforces a coin's transfer rules until it graduates | Transfer-hook rules on Meteora coins (`LAUNCHPAD_HOOK_PROGRAM_ID`) |
| `contracts/curve-pump-public` | Solana | A bonding curve that graduates into PumpSwap, with its finite DAMM mode (`DAMM-MODE.md`) | The optional PumpSwap launches on your own program |
| `contracts/curve-damm-pump-fee` | Solana | Fee-aware controller for new PumpSwap launches ($20,000 start, $50,000 graduation) | The same, for new launches |
| `contracts/curve-damm-pump-admin-test` | Solana | Owner-only test controller with tiny curve numbers | Rehearsing the PumpSwap flow with small amounts |
| `contracts/curve-pump-test` | Solana | Private test program prototype (inert unless built for one owner wallet) | Owner tests only |
| `contracts/curve-launch-evm` | Robinhood Chain | Factory, token, bonding curve, Uniswap v4 graduation, fee split and transfer rules (Solidity, Foundry) | Robinhood Chain launches ([ROBINHOOD.md](ROBINHOOD.md)) |
| `contracts/RobinhoodExecutor.sol` | Robinhood Chain | Trade executor, with its compiled artifact in `contracts/artifacts/` | Robinhood Chain trading |

**Nothing in this repository points at a deployed program.** The program ids, operator and treasury addresses in the
code are placeholders. To use a program, build it, deploy it from your own wallet and put your addresses in the
settings or pins described below.

The trade executor's artifact (`contracts/artifacts/RobinhoodExecutor.json`) is built from
`contracts/RobinhoodExecutor.sol`. Rebuild it with your own compiler before you deploy it (`npm ci`, then
`npm run robinhood:compile`); the admin panel refuses to prepare a deployment when the source and the artifact differ.

## Building the Solana programs

Each Solana program has a `build-*.sh` script. You need Rust and the Solana platform tools (the `cargo build-sbf`
toolchain from the Solana CLI, https://solana.com/docs/intro/installation):

```bash
cd contracts/curve-transfer-hook
cargo build-sbf                        # or: ./build-hook.sh with LAUNCHPAD_PLATFORM_TOOLS and LAUNCHPAD_SBF_SDK set
sha256sum target/deploy/*.so
```

The scripts print the SHA-256 of the build. Built `.so` files are not committed (`.gitignore`).

The Python tests next to each program (`tests/*.py`) run its build (`artifacts/*.so`, from the `build-*.sh` script) in
LiteSVM with recorded mainnet accounts. They need `pip install solders` (it includes LiteSVM) and copies of the third-party programs they call, which are not in this
repository: `contracts/curve-pump-public/tests/capture_damm_programs.py --rpc <your RPC URL>` reads Meteora DAMM v2,
PumpSwap and Pump fees from mainnet into the test fixtures.

## The transfer hook

1. Build it (above) and deploy it with the Solana CLI from a wallet you control:
   ```bash
   solana-keygen new -o hook-program-keypair.json          # the program's address; keep this file private
   solana program deploy --program-id hook-program-keypair.json target/deploy/curve_transfer_hook.so
   ```
2. Put its address in `/etc/launchpad.env` as `LAUNCHPAD_HOOK_PROGRAM_ID=<program id>` and restart.
3. Run `node scripts/check-hook-readiness.mjs` with the settings loaded.

`deploy/launchpad-hooks.env.example` lists the other hook settings. Consider making the program immutable
(`solana program set-upgrade-authority --final`) once you have tested it, so holders know its rules cannot change.

## The PumpSwap programs

These run the optional PumpSwap launch mode on your own program. The admin panel deploys them from the browser: the
server builds unsigned transactions for a pinned binary and your deployment wallet signs them. Before that works, the
pins must describe your build:

1. **Choose two wallets**: an operator (deploys and administers the program) and a treasury (receives the protocol's
   fees). Use wallets you control; the server never holds their keys.
2. **Put them in the program.** In the program's `src/lib.rs`, replace the `ADMIN` and `TREASURY` addresses. The
   template uses the placeholders `7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS` (operator) and
   `HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF` (treasury) throughout `src/`, `public/` and `contracts/`; find them
   all with `grep -rl 7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS src public contracts`.
3. **Build** with the folder's `build-*.sh` and copy the `.so` where the server reads it:

   | Pin (`src/`) | Binary on the server |
   |---|---|
   | `pump-public-deployment.mjs` | `private/pump-public/curve_pump_public.so` |
   | `damm-pump-deployment.mjs` | `private/damm-pump/curve_damm_pump.so` |
   | `damm-pump-fee-deployment.mjs` | `private/damm-pump-fee/curve_damm_pump_fee.so` |
   | `damm-pump-test-deployment.mjs` | `private/damm-pump-admin-test/curve_damm_pump_admin_test.so` |
   | `pump-test-deployment.mjs` | `private/pump-owner-test/curve_pump_test_OWNER_REQUIRES_REVIEW.so` |

4. **Make the pin.** Pick two new seeds (up to 32 characters, for example `mypad-public-v1` and `mypad-public-buf-v1`)
   and run:
   ```bash
   node scripts/program-pins.mjs --operator <operator> --treasury <treasury> \
     --program-seed mypad-public-v1 --buffer-seed mypad-public-buf-v1 \
     --binary private/pump-public/curve_pump_public.so
   ```
   It prints the binary's hash and length and the program, buffer and ProgramData addresses your operator will
   create. Paste them over the matching lines of the pin's `*_DEPLOYMENT_POLICY`, and replace the old program id
   wherever `grep -rl <old program id> src public` finds it.
5. Restart the service and open the program's section in the admin panel. It checks the binary against the pin before
   it offers any transaction.

The deployment tests in `test/` pin the template's placeholder values, so they fail once you rebind; keep your own
pins in your fork and update those tests with them.

## Robinhood Chain contracts

`contracts/curve-launch-evm` is a Foundry project with no external installs except Uniswap v4 core for the tests:

```bash
cd contracts/curve-launch-evm
node scripts/vendor-v4-core.mjs        # fetches Uniswap v4 core into test/vendor (tests only)
forge build && forge test
```

Deployment and the settings that point the launchpad at your contracts are in [ROBINHOOD.md](ROBINHOOD.md).

## Audits

None of these programs has had a professional audit. The READMEs describe the checks and tests each one passed. Have
them reviewed before you put real money behind them, and deploy with small limits first.
