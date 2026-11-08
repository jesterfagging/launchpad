# Launchpad → PumpSwap private test program

> The program ids, operator, treasury and other addresses in this document are placeholders from the open-source
> template, not live deployments. Build and deploy your own and update the pins as described in
> [docs/PROGRAMS.md](../../docs/PROGRAMS.md).

This is an independently compiled Solana program prototype plus executable local tests. It is not a professional audit, a guarantee of safety, or a deployed program. No RPC calls, deployments, wallet imports, mainnet transactions, or real-fund tests occurred in this package's test harness.

## Build modes and status

- **Default:** rejects every instruction with error 7000. `artifacts/curve_pump_test_DISABLED.so` is this inert build.
- **`local-test`:** public deterministic operator fixture (32 bytes each equal to 99), for LiteSVM only. **NEVER DEPLOY `artifacts/curve_pump_test_LOCAL_ONLY.so`. Anybody knows its signing key.** It exists to verify actual custody, token operations, Pump CPI and atomic rollback locally.
- **`owner-test`:** separately compiled with `LAUNCHPAD_TEST_OPERATOR` equal to the owner's actual wallet public key. The owner build helper refuses missing or included public test keys. The lower-level Cargo build permits the additional public seed-71 fixture strictly for owner-feature VM verification; do not deploy that verification artifact. The build also validates an on-curve wallet key; runtime requires that pinned key to sign. Both enabled features cannot coexist. No owner binary is included because no real owner public key was provided.

The owner build restricts all initialization, buys, sells and migration to that pinned signer. It pins a **$100 start / $500 graduation reference curve**, 1 billion initial tokens, six decimals, 28.85% graduation fee and 1% bonding trading fee. These USD references use a frozen SOL/USD snapshot; they are not guaranteed USD values if SOL moves. The contract pins the corresponding virtual-base reserve and terminal token allocation. Initial virtual SOL reserve is frozen at initialization, with a maximum 3 SOL graduation principal; actual tracked principal may not exceed 3 SOL. Initialization rent subsidy is 0.02–0.1 SOL, separately funded by the operator and excluded from bonding principal. There is no public launch or permissionless buyer path in this prototype.

## Custody and atomicity

- State PDA: `["curve", mint]`, owned by this program.
- Authority PDA: `["vault", mint]`, a data-empty System Program account with no private key. Only this program can sign transfers from it using its PDA seeds.
- Native SOL principal is held by that authority PDA. The ledger tracks principal separately from rent subsidy and unsolicited lamports. There is no withdrawal, configurable arbitrary CPI, treasury update or state-close instruction.
- Base token vault: canonical classic SPL ATA of authority and mint. Initialization creates the complete token supply then permanently revokes mint authority in the same instruction. Freeze authority must be absent. Only classic SPL mints are accepted; this prototype has no transfer tax, creator rewards or holder distributions.
- Treasury, operator, mint, fee rates, virtual reserves and graduation allocation are immutable in state.
- Buys calculate token output from a maximum SOL budget, then charge only the rounded-up SOL necessary for those actual tokens. The final buy clips to the exact cap. Unused budget is never debited. Sells round payout down and validate principal coverage.
- Individual holder burns do not freeze the curve: original minted allocation stays the accounting reference while current mint supply may decrease. Token/SOL donations do not alter the pricing ledger.
- Reaching the cap marks Ready. **Sells remain possible while Ready** and return the curve to Trading. If graduation cannot proceed, the operator can redeem held tokens against remaining principal; already paid trading fees are not refunded. Network fees and integer rounding still apply.
- Migration wraps exact tracked quote minus the graduation fee, creates the externally owned PumpSwap pool through a pinned program ID, verifies actual source/destination balance changes, burns **every LP token actually credited to the program's canonical LP ATA**, verifies the LP supply decrease and zero resulting LP ATA balance, and pays the frozen treasury exactly once. Only then does state become Migrated. These steps occur in one instruction/transaction. A failure after even the LP burn rolls all steps back.
- PumpSwap's internal minimum LP accounting is not assumed to be zero. The promise is all LP received by this migration is burned; other future liquidity providers are independent.

## Destination dust recovery

Migration accepts a u16 pool index. It derives and checks every destination pool, mint and ATA from that index, the pinned Pump program, authority and mints. Existing nonzero destination reserves cause a rejection rather than silently changing price. A failed attempt can retry a clean index without changing fees, custody or curve economics. The selected pool/index is stored only on successful migration. Repeating the same completed migration returns success without charging again; attempting another destination after success rejects.

This mitigates a reproducible denial of migration from an outsider dusting the predicted first reserve ATA. A sufficiently resourced attacker can theoretically pre-fund all 65,536 indices or repeatedly front-run attempted destinations. Ready-state sells preserve redemption if no clean destination remains. Stronger destination selection and public-holder independent redemption require additional design before any public launch mode; this owner-only experiment is not a public custody solution.

## Instruction interface

All integers are unsigned little-endian. Fee rates are basis points. Token amounts are raw six-decimal atoms; quote amounts are lamports. The signer is always the pinned operator.

**0 Initialize:** byte `0` followed by six u64 values: `virtualBase`, `virtualQuote`, `soldCap`, `migrationRentBudget`, `graduationFeeBps`, `tradeFeeBps`.

Accounts in order:
`operator(signer,w), state(w), authority(w), baseMint(w), baseATA(w), treasury, system, classicToken, associatedTokenProgram`.

Before this instruction the client must create a fresh classic SPL mint, six decimals, mint authority equal to the authority PDA, freeze authority absent, initial supply zero. Initialization itself mints all supply and revokes mint authority. These preliminary operations can share the same transaction. It tolerates pre-funded state and authority PDA addresses; it does not allow reinitialization.

**1 Buy / 2 Sell:** opcode followed by `input:u64`, `minimumOutput:u64`. Buy input is maximum SOL budget and output is token atoms; sell input is token atoms and output is SOL. Both must be nonzero.

Accounts: `operator(signer,w), state(w), authority(w), baseMint, baseATA(w), operatorTokenAccount(w), treasury(w), system, classicToken`.

Operator token account must be initialized classic SPL, correct mint and owned by operator, with no delegate/close authority. The interface uses its canonical ATA by convention; on-chain ownership/mint checks accept any such valid operator account.

**3 Migrate:** opcode followed by `poolIndex:u16`.

Accounts: `operator(signer,w), state(w), authority(w), baseMint, baseATA(w), treasury(w), PumpGlobal, pool(w), WSOLMint, lpMint(w), authorityWSOL(w), authorityLP(w), poolBase(w), poolQuote(w), system, classicToken, token2022, associatedTokenProgram, eventAuthority, PumpProgram`.

Pump pool PDA: `["pool", u16index, authority, baseMint, WSOL]`. LP mint PDA: `["pool_lp_mint", pool]`. Event authority: `["__event_authority"]`. The program rejects wrong programs/accounts and duplicate alias accounts. LP token mint/accounts use Token-2022, as required by PumpSwap; the launched mint is classic SPL.

## State layout (256 bytes)

| Offset | Value |
|---|---|
| 0–7 | `CRVPTEST` magic |
| 8 | phase: 0 Trading, 1 Ready, 2 Migrated |
| 9 | authority PDA bump |
| 16, 48, 80 | operator, treasury, mint pubkeys (32 bytes each) |
| 112, 120 | current virtual base, virtual quote (u64) |
| 128, 136, 144 | sold cap, current sold, accounted quote (u64) |
| 152, 160, 168 | native rent floor, graduation bps, trade bps (u64) |
| 176, 184 | initial virtual base, initial virtual quote (u64) |
| 192, 200 | successful migration LP burned, graduation fee (u64) |
| 208 | committed Pump pool pubkey |
| 240 | committed pool index (u16) |

## Reproduce locally

Dependencies: Solana platform-tools v1.57 Rust/compiler, sbf-sdk v4.3.0, Python with `solders` providing LiteSVM. `Cargo.lock` pins the Rust dependency graph. The build helper assumes already-installed tools and never deploys:

```sh
LAUNCHPAD_PLATFORM_TOOLS=/absolute/path/to/platform-tools \
LAUNCHPAD_SBF_SDK=/absolute/path/to/sbf-sdk \
./build-local.sh
PYTHONPATH=/path/to/python/dependencies \
PUMP_TEST_BINARY=/path/to/read-only/pump-mainnet.so \
python tests/local_vm.py
```

The Pump executable used for the recorded tests has SHA-256 `feb2ec72199f35999bbfd26ada811a37d297464ab265c78593b2d4717d7d42b5`. `fixtures/pump-global.json` is its read-only fetched global configuration snapshot. Neither this binary nor the local VM contacts a network while tests execute. The external Pump binary is not an artifact produced or audited by Launchpad.

To prepare the separate owner artifact after choosing a real operator public key, use `build-owner.sh` with the same compiler paths and `LAUNCHPAD_TEST_OPERATOR`. It refuses known fixture keys and writes only an artifact; **it does not deploy, sign, or broadcast**. The owner artifact, deployed program identity, upgrade authority policy, transaction contents, and on-chain binary hash must be checked before any funded test.

## Evidence and limits

`local-vm-results.json` records actual executable tests, binary hashes, examples and measured compute units. Both standard $20k/$50k model fixture and micro $100/$500 fixture execute real Pump pool creation and LP burning inside LiteSVM. Tests cover unauthorized callers, fee substitution, duplicate aliases, voluntary burns, donations, exact cap, slippage, insufficient reserves, destination-index retry, full redemption while migration is blocked, idempotency and failure after burn rolling back all state.

These tests are not a guarantee of no vulnerabilities. They do not test production RPCs, wallet adapters, mainnet inclusion speed, third-party trading-terminal indexing/discovery, upgrade authority handling, oracle reliability, a public buyer population, every Pump upgrade, or arbitrary quote mints. The custody program supports SOL only even if the web research UI previews other quote assets. The 1% trading fee is additional to the 28.85% graduation fee; both are frozen. Large development toolchains, Cargo build intermediates, credentials and keys must never be copied to the server with the app.
