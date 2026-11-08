# Launchpad transfer hook

The on-chain half of Launchpad's **transfer hook rules** (v71.28, rules v2). A hooked
coin is a Token-2022 mint on Meteora's Dynamic Bonding Curve whose `TransferHook`
extension points at this program. Token-2022 calls it on every transfer of the
coin (after the balances moved); the program checks the creator's rules and
fails the transfer when one is broken. It never moves funds, takes fees or
changes balances. The swap that completes the curve revokes the hook (Meteora's
`revoke_transfer_hook` runs inside that swap, before migration), so every rule
ends at graduation.

Written against `solana-program` alone (no Anchor, no spl crates, hand-written
byte layouts), like `contracts/curve-damm-pump-fee`. The program id is whatever
the owner deploys; Launchpad reads it from `LAUNCHPAD_HOOK_PROGRAM_ID` and every PDA is
derived under it. Not professionally audited.

**Status.** The rule engine's modules and handlers have unit tests (`cargo test`). Build the program with
`cargo build-sbf`, deploy it to devnet and try a hooked launch there before you switch the feature on for mainnet.

## Files

| file | role |
|---|---|
| `src/lib.rs` | entrypoint, instruction dispatch, account checks, PDA creation, Execute wiring (clock, stack height, sysvar account) |
| `src/execute.rs` | the rule engine: pure functions over plain inputs (every rule, every boundary unit-tested), validation, the conflict table |
| `src/state.rs` | `HookConfig`, `WalletState`, `AllowEntry`, `BlockList` layouts; Token-2022 account/mint views |
| `src/instructions.rs` | instruction data parser (tags 0–5, interface discriminators) |
| `src/tlv.rs` | ExtraAccountMetaList writer: the shape per rule set, pinned by `test/fixtures/hook-tlv.json` |
| `src/calendar.rs` | dates from unix days, weekdays, Gregorian Easter, NYSE holidays, US/EU daylight saving, open/closed decisions |
| `src/osc.rs` | SIN table (16.16), phases, energy decay by squaring, kicks, caps, the coupled resonator step |
| `src/sysvar.rs` | instructions-sysvar parser: priority fee, Jito tips, tithe transfers, app marks (pure, over the account bytes) |
| `src/errors.rs` | error codes, names and texts (mirrored by `src/hooks/program.mjs`) |
| `build-hook.sh` | SBF build with the owner's platform tools |

The JS side (`src/hooks/program.mjs`) is the reference encoder: PDAs, instruction
builders, the same TLV bytes, account decoders, the Execute account resolver and
`HOOK_ERRORS`. `test/hook-program.test.mjs` checks it against the fixture and
against `src/errors.rs`, `src/state.rs`, `src/instructions.rs` and `src/execute.rs`
(offsets, codes, texts, the conflict table).

## Vocabulary

Venue = the DBC base vault token account (config `venues[0]`; `venues[1]` is a
spare, zero). A transfer whose source is a venue is a **buy**, whose destination
is a venue a **sell**, anything else a **send** (wallet-to-wallet). Exempt owners
(config `exempt[4]`: creator wallet, Launchpad partner authority, leftover receiver,
DAMM v2 pool authority): a venue transfer whose wallet side is exempt skips every
rule (fee claims, settlement, the creator's own trades); sends by or to an exempt
owner are still checked except where a rule says the creator is exempt (the
destination-side rules skip an exempt receiver; venue-locked lets an exempt owner
move coins). The venue's own owner (the DBC pool authority) is never consulted:
it signs every buy. Balances seen by Execute are post-transfer;
`pre_balance = source post-balance + amount`. Zero-amount transfers are no-ops.
The clock (`started_at`, `start_slot`) starts at the first venue transfer.
`share(total, bps) = total × bps / 10000` and `share_ppm(total, ppm) = total ×
ppm / 1 000 000`, both with u128 intermediates and checked arithmetic.

## Accounts

All program-owned, little-endian, fixed size. Byte 0 is the layout version (1;
the earlier layout was never deployed, so v2 keeps the byte).

### `HookConfig` — PDA `["config", mint]`, 752 bytes, writable in Execute

| offset | size | field |
|---:|---:|---|
| 0 | 1 | version = 1 |
| 1 | 1 | bump |
| 2 | 32 | mint |
| 34 | 32 | creator (the only signer AddAllowed / RemoveAllowed / AddBlocked / InitializeExtraAccountMetaList accept) |
| 66 | 4 × 32 | exempt[4]: creator wallet, Launchpad partner authority, leftover receiver, DAMM v2 pool authority (zero = unused) |
| 194 | 2 × 32 | venues[2]: the DBC pool's base vault token account; second slot spare (zero = unused) |
| 258 | 32 | gate_mint (holder-gated only, else zero) |
| 290 | 32 | gate_token_program (holder-gated only, else zero) |
| 322 | 8 | started_at i64: unix time of the first venue transfer (0 until then) |
| 330 | 8 | start_slot u64 |
| 338 | 1 | rule_count (1..4) |
| 339 | 4 × 49 | rules[4]: kind u8, params[6] u64 (slots 339, 388, 437, 486) |
| 535 | 32 | tithe_recipient (tithe only, else zero) |
| 567 | 8 | swap_base_amount u64: base tokens the curve sells before graduation (the PoolConfig's `swapBaseAmount`; sliding caps) |
| 575 | 8 | vault_initial u64: the base vault's balance before the first buy (0 = not captured yet; sliding caps) |
| 583 | 8 | volume_bought u64: cumulative non-skipped buy volume (chapters) |
| 591 | 8 | last_slot u64 (anti-bundle) |
| 599 | 8 | slot_trades u64: venue trades seen in `last_slot` (anti-bundle) |
| 607 | 32 | potato_holder (hot potato; zero = nobody) |
| 639 | 8 | potato_since i64 |
| 647 | 1 | turn_side: 0 none, 1 buy, 2 sell (ping pong) |
| 648 | 8 | turn_ts i64 |
| 656 | 8 | osc_energy u64: E or E1, millionths (1 000 000 = 1.0) |
| 664 | 8 | osc_energy2 u64: E2 (coupled resonator) |
| 672 | 8 | osc_phase u64: 1/65536 of a cycle |
| 680 | 8 | osc_ts i64: last oscillator update |
| 688 | 64 | reserved (zero) |

Everything from offset 575 on, plus `started_at` / `start_slot`, is the mutable
state (`ConfigState` in the code); `pack_dynamic` writes exactly those fields.
Everything else is written once by InitConfig.

### `WalletState` — PDA `["wallet", mint, owner]`, 34 bytes, writable (holder_vesting only)

| offset | size | field |
|---:|---:|---|
| 0 | 1 | version = 1 |
| 1 | 1 | bump |
| 2 | 8 | first_receipt_ts i64: start of the wallet's vesting clock (0 = never had a qualifying receipt) |
| 10 | 8 | received_total u64: sum of qualifying receipts while vesting applies |
| 18 | 16 | reserved (zero) |

A WalletState that does not exist (account not owned by the program) is "not
registered". Only `holder_vesting` uses it: a qualifying receipt by a plain wallet
fails with `WalletNotRegistered` (6100) when the receiver has none; Launchpad
prepends `RegisterWallet` (payer = trader) to such buys. Execute never creates
it.

### `AllowEntry` — PDA `["allow", mint, wallet]`, 66 bytes

| offset | size | field |
|---:|---:|---|
| 0 | 1 | version = 1 |
| 1 | 1 | bump |
| 2 | 32 | mint |
| 34 | 32 | wallet |

Existence = allowed. The mint and wallet are stored so the allowlist can be
listed from chain (`getProgramAccounts`, `dataSize: 66`, `memcmp offset 2 =
mint`; `allowEntryFilters(mint)` in the JS module) and so RemoveAllowed can
re-derive the address it closes.

### `BlockList` — PDA `["block", mint]`, 6408 bytes (blocklist only)

| offset | size | field |
|---:|---:|---|
| 0 | 1 | version = 1 |
| 1 | 1 | bump |
| 2 | 1 | count (0..200) |
| 3 | 5 | padding (zero) |
| 8 | 200 × 32 | wallets (the first `count` are set) |

Created by the first AddBlocked (rent paid by the payer), sealed by the first
trade (`config.started_at != 0`). The program reads and writes it in place through
slice views: a 6.4 KiB struct would not fit the 4 KiB BPF stack frame. A block
PDA that is not owned by the program is an empty list.

### `ExtraAccountMetaList` — PDA `["extra-account-metas", mint]`, 16 + 35 × count bytes

The standard `spl-tlv-account-resolution` layout Token-2022 reads:
`type[8] = execute discriminator | length u32 = 4 + 35 × count | count u32 |
count × { discriminator u8, address_config[32], is_signer u8 = 0, is_writable u8 }`.
Seeds encode as literal `[1, len, bytes]`, instruction data `[2, index, len]`,
account key `[3, index]`, account data `[4, index, offset, len]`. Account
indices of an Execute call: 0 source, 1 mint, 2 destination, 3 authority,
4 this list, 5 the HookConfig, then the present entries below in order (the
**shape**; `tlv::Shape::from_rules`, JS `hookShape(rules)`):

| # | account | present when | address | writable |
|---:|---|---|---|---|
| 0 | HookConfig | always | hook PDA: `"config"`, key(1) | yes |
| 1 | Instructions sysvar | sniper_fee_cap, tithe, fomo_only or pump_app_only (`needsSysvar`) | literal `Sysvar1nstructions1111111111111111111111111` | no |
| 2 | BlockList | blocklist | hook PDA: `"block"`, key(1) | no |
| 3 | source-owner WalletState | holder_vesting (`needsWalletState`) | hook PDA: `"wallet"`, key(1), data(0)[32..64] | yes |
| 4 | destination-owner WalletState | holder_vesting | hook PDA: `"wallet"`, key(1), data(2)[32..64] | yes |
| 5 | destination-owner AllowEntry | allowlist | hook PDA: `"allow"`, key(1), data(2)[32..64] | no |
| 6 | associated-token program | holder_gated | literal `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | no |
| 7 | gate token program | holder_gated | literal (from the config) | no |
| 8 | gate mint | holder_gated | literal (from the config) | no |
| 9 | destination owner's gate ATA | holder_gated | PDA of the program at the ATA-program index: data(2)[32..64], key(gate token program index), key(gate mint index) | no |

The gate ATA's external-PDA discriminator (128 + index of the ATA program) and
its key() seeds use the **actual** instruction indices of the three literal
entries, which shift when the sysvar/blocklist/wallet entries are absent: in the
plain holder-gated shape they are 6, 7, 8 (discriminator 134, seeds `key(7)`,
`key(8)`); with the sysvar present 7, 8, 9; in the (impossible) full shape 11,
12, 13. Both WalletState seeds read the owner out of the token account's data
rather than taking account 3 (the transfer authority may be a delegate); the
program verifies every WalletState against the real owner. Sizes: config-only
51, +sysvar or +blocklist 86, route (config + wallets + allow) 156, holder-gated
191, full 366 (10 entries, 15 accounts). `test/fixtures/hook-tlv.json` pins the
exact bytes of six shapes (configOnly, sysvar, blocklist, route, holderGated,
full); `tlv.rs` and `test/hook-program.test.mjs` both assert them.

The DBC pool account is **not** an extra account (Anchor holds it mutably
borrowed during the swap). Progress to graduation is derived from the base
vault's balance instead (see sliding_caps).

## Instructions

A 1-byte tag, then a fixed layout (no borsh). Token-2022 sends Execute with the
8-byte interface discriminator; the initialize discriminator is accepted as an
alias of tag 0; the update discriminator is rejected (the list is immutable).

| data | instruction | accounts |
|---|---|---|
| `[0]` (a trailing byte is accepted and ignored) or `sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[0..8]` | **InitializeExtraAccountMetaList** | 0 extra-metas PDA (w), 1 mint, 2 authority (signer: the creator), 3 system program, 4 payer (signer, w), 5 HookConfig |
| `[1] ++ exempt[4][32] ++ venues[2][32] ++ gate_mint[32] ++ gate_token_program[32] ++ tithe_recipient[32] ++ swap_base_amount u64 ++ rule_count u8 ++ rules[4]{kind u8, params[6] u64}` (494 bytes; payload offsets 0, 128, 192, 224, 256, 288, 296, 297) | **InitConfig** | 0 config PDA (w), 1 mint, 2 creator (signer), 3 payer (signer, w), 4 system program |
| `[2] ++ wallet[32]` | **AddAllowed** | 0 config, 1 creator (signer), 2 payer (signer, w), 3 allow PDA (w), 4 system program |
| `[3]` | **RemoveAllowed** | 0 config, 1 creator (signer), 2 allow PDA (w), 3 refund wallet (w) |
| `[4]` | **RegisterWallet** | 0 config, 1 wallet (the owner; need not sign), 2 payer (signer, w), 3 wallet-state PDA (w), 4 system program |
| `[5, n] ++ n × wallet[32]` (1 ≤ n ≤ 28) | **AddBlocked** | 0 config, 1 creator (signer), 2 payer (signer, w), 3 block PDA (w), 4 system program |
| `sha256("spl-transfer-hook-interface:execute")[0..8] ++ amount u64` | **Execute** | the Token-2022 list above |

Discriminators: execute `[105,37,101,197,75,251,102,26]`, initialize
`[43,34,13,49,167,88,235,235]`, update `[157,105,42,146,102,85,241,174]`.

* **InitConfig** validates the rules (kinds 1–25, no duplicates, no catalogue
  conflict pair — `execute::CONFLICTS` mirrors `HOOK_CONFLICTS` —, parameter
  ranges: bps ≤ 10000, nonzero divisors, see `validate_rule`), requires
  `venues[0]`, the gate keys when `holder_gated` is present, a nonzero
  `tithe_recipient` when `tithe` is present and a nonzero `swap_base_amount` when
  `sliding_caps` is present. Fails with `AlreadyInitialized` if the config exists.
  The mint account need not exist yet: Launchpad's hook-setup transaction runs
  InitConfig and InitializeExtraAccountMetaList *before* Meteora's
  `createPoolWithTransferHook` creates the mint, so the mint is only a key here.
* **InitializeExtraAccountMetaList** runs **after InitConfig**: the list's shape
  and the gate literals come from the config (6th account), and the authority
  must be the config's creator (`NotAllowed`). Order inside Launchpad's hook-setup
  stage: `InitConfig`, `InitializeExtraAccountMetaList`, then the first
  `AddBlocked` chunk (≤ 16 wallets) when the blocklist rule is present; further
  chunks of ≤ 28 are separate approvals; then the pool creation.
* **AddBlocked** creates the BlockList on first use, appends the wallets (ones
  already listed, or repeated inside the batch, are skipped silently; a zero key
  is `BadAccounts`), refuses a result above 200 wallets (`BlocklistFull`, nothing
  written) and refuses once `started_at != 0` (`LaunchStarted`: the first trade
  seals the list).
* **AddAllowed** is idempotent (an existing entry for the wallet is fine);
  **RemoveAllowed** refunds the entry's lamports to the refund wallet, wipes the
  data and hands the account to the system program. **RegisterWallet** is
  idempotent; anyone may pay to register any wallet.
* Every PDA is created rent-exempt through the system program with the PDA's
  seeds. An address that already holds lamports (anyone can send some) is topped
  up, allocated and assigned in place, so nobody can block a registration, an
  allowlist entry or the blocklist by pre-funding it.
* Owners are checked: config/wallet/allow/block accounts must be owned by this
  program and re-derive from their stored bump; token accounts and the mint must
  be owned by Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`); the two
  token accounts must carry the `transferring` flag Token-2022 sets for the
  duration of a transfer (`NotTransferring` otherwise), so Execute cannot be
  called directly. Accounts 3 (authority) and 4 (the list Token-2022 validated)
  are not read. A WalletState, AllowEntry or BlockList that is not owned by the
  program counts as absent; one that is owned must parse and sit at its PDA. The
  sysvar slot must hold the instructions sysvar (`BadSysvar` otherwise, also for
  malformed sysvar data). The gate ATA must be a token account of the destination
  owner for the gate mint under the gate token program (its balance counts; a
  missing account is a balance of zero).
* A self-transfer (both token accounts owned by one wallet) resolves both
  WalletStates to the same account, which is read once; it receives nothing new
  for vesting and never needs a record.

## Execute semantics

`execute_transfer(program_id, accounts, amount, now, slot, stack_height)`:
`now`/`slot` from the clock sysvar, `stack_height` from
`solana_program::instruction::get_stack_height()`. The evaluation order is:

1. zero amount → nothing happens;
2. on a venue transfer (exempt or not): the clock starts if unset; the first buy
   records `vault_initial` (sliding caps present); the oscillator (momentum /
   resonance / coupled resonator) decays and advances to `now`;
3. a skipped transfer (venue-to-venue, or a venue transfer whose wallet side is
   exempt) stops here;
4. every rule's check runs in config order — the first failure wins with that
   rule's code (6000 + kind) — then every rule's state update. A check therefore
   sees the state before this transfer.

`supply` is the mint's supply (mint data [36..44]). Parameters are the six u64
values the catalogue's `hookRuleParams` emits (`public/hook-catalog.mjs`),
`elapsed` = seconds since `started_at` (none before the clock starts).

| kind | rule | params | check / state |
|---:|---|---|---|
| 1 | allowlist (Launchpad route) | – | a plain, non-exempt receiver (buy or send) must have an AllowEntry |
| 2 | holder_gated (Launchpad route) | p0 min gate units, p1 gate decimals (informational) | receiver's gate ATA balance ≥ p0 (missing ATA = 0); exempt receivers and venues skip |
| 3 | holder_vesting (Launchpad route) | p0 early-window s (0 = all), p1 cliff s, p2 period s, p3 unlock bps per period, p4 min qualifying ppm of supply | **Receipt** (plain receiver, not a self-transfer): `qualifying = amount ≥ share_ppm(supply, p4) and (p0 == 0 or the clock has not started or now ≤ started_at + p0 or receiver.first_receipt_ts ≠ 0)`; a qualifying receipt needs the receiver's WalletState (else 6100), stamps `first_receipt_ts` once and adds to `received_total`; non-qualifying receipts need nothing. **Sending** (plain non-exempt source with a record): unlocked bps `f = 0` before `first + cliff`, then `min(10000, p3 × (1 + floor((now − first − cliff) / p2)))`; `locked = received_total − share(received_total, f)`; allowed iff `src_post_balance ≥ locked`. No record or `first_receipt_ts == 0` = nothing locked. Sends of qualifying size also need the receiver registered (documented limitation). |
| 4 | anti_dump | p0 max buy bps of supply (0 = none), p1 max sell bps | buy: `amount ≤ share(supply, p0)` when p0 > 0; sell or send: `amount ≤ share(supply, p1)` |
| 5 | sliding_caps | p0 levels (1..5), p1 buy caps levels 0..3 (4 × u16 bps, 0 = none), p2 sell caps 0..3, p3 breakpoints 1..4 (u16 bps of progress, strictly rising), p4 = buy4 \| sell4 << 16 | venue trades only. `progress = min(10000, (vault_initial − vault_now) × 10000 / swap_base_amount)` with `vault_now` the venue's post balance (source on a buy, destination on a sell); level = number of breakpoints ≤ progress; buy ≤ buy cap of the level (if > 0), sell ≤ sell cap. `vault_initial` is captured by the first buy even when that buy is exempt (the baseline is the vault before anyone bought) |
| 6 | graduated_sell_caps | p0 small-holder cap bps, p1 big-bag cap bps, p2 bag bps of supply | sell or send: `bag = share(supply, p2)`, `cap = p0 − (p0 − p1) × min(pre_balance, bag) / bag` (u128), `amount ≤ share(supply, cap)` |
| 7 | max_per_wallet | p0 bps | plain non-exempt receiver post balance ≤ `share(supply, p0)` |
| 8 | rising_max_per_wallet | p0 start bps, p1 mode (0 step, 1 double), p2 step bps, p3 interval s | `n = floor(elapsed / p3)` (0 before the clock), `cap = min(10000, p0 + n × p2)` or `min(10000, p0 × 2^n)` (saturating); receiver post balance ≤ `share(supply, cap)` |
| 9 | chapters | p0 start bps, p1 volume per chapter (base units) | `cap = min(10000, p0 × 2^floor(volume_bought / p1))`; receiver post balance ≤ `share(supply, cap)`; after a non-skipped buy `volume_bought += amount`; sells into the pool are never capped |
| 10 | trade_guard | p0 bps | every buy, sell and send: `amount ≤ share(supply, p0)`; the creator is not exempt on sends |
| 11 | anti_bundle | p0 max trades per slot | every non-skipped venue trade: `slot == last_slot ? slot_trades += 1 : (last_slot = slot, slot_trades = 1)`; fail if `slot_trades > p0`; sends don't count |
| 12 | venue_locked | – | a send fails unless an exempt owner sends or receives |
| 13 | market_hours (NYSE) | p0 after-hours mode (0 closed, 1 sells stay open), p1 holidays (0 closed, 1 ignore) | buys always, sells unless p0 == 1: open = Mon–Fri, 09:30 ≤ New York time < 16:00, not a holiday (p1 == 0). New York = UTC − 5 h, − 4 h while US daylight saving is active (second Sunday of March 02:00 standard → first Sunday of November 02:00 daylight). Holidays: New Year's Day (observed Monday when on a Sunday, not observed when on a Saturday), MLK Day (3rd Mon Jan), Presidents' Day (3rd Mon Feb), Good Friday (Gregorian Easter − 2), Memorial Day (last Mon May), Juneteenth, Independence Day, Christmas (observed Fri/Mon), Labor Day (1st Mon Sep), Thanksgiving (4th Thu Nov). Early closes are ignored. Sends always pass |
| 14 | ping_pong | p0 min ppm of supply to take the turn (0 = any), p1 free-up s (0 = never) | venue trade with `amount ≥ share_ppm(supply, p0)`: if `turn_side == this side` and (p1 == 0 or `now < turn_ts + p1`) → fail; else `turn_side = side, turn_ts = now` (global turn). Smaller trades and sends pass untouched |
| 15 | breathing_cap | p0 cycle s, p1 base bps, p2 swing % of base, p3 floor bps | buys by plain non-exempt receivers: `cap = clamp(p1 + p1 × p2/100 × sin(2π × elapsed / p0), p3, 10000)` (SIN table; the base before the clock starts); `amount ≤ share(supply, cap)`. Sells and sends never capped |
| 16 | momentum | p0 natural period s, p1 damping %/s, p2 buy energy %, p3 base bps, p4 floor bps | state E (1e6 = 1.0), φ (1/65536 cycle), osc_ts. Every venue transfer: `dt = now − osc_ts` (0 on the first), `E ← E × (1 − p1/100)^dt` (by squaring; 0 once dt ≥ 600 s), `φ += dt × 65536 / p0 mod 65536`. Buy cap = `clamp(p3 × (1 + E × sin φ), p4, 10000)`; after a non-skipped plain buy `E = min(1e6, E + p2/100 × min(1, amount / share(supply, p3)) × 1e6)`. Sells/sends never capped |
| 17 | blocklist | – | a plain non-exempt receiver (buy or send) must not be in the BlockList |
| 18 | hot_potato | p0 min buy ppm (0 = any), p1 cold s (0 = never) | a sell or send whose source owner is `potato_holder` fails unless `p1 > 0 and now ≥ potato_since + p1`; after the checks a qualifying buy (plain non-exempt receiver, `amount ≥ share_ppm(supply, p0)`) sets `potato_holder = receiver, potato_since = now` |
| 19 | dex_only | – | `get_stack_height() ≥ 3` (Token-2022 at 1 and the hook at 2 when a wallet signs the transfer itself; ≥ 3 through the pool or a router). Buys, sells and sends alike |
| 20 | p2p_only | – | a buy fails unless the receiver's owner is the creator; every sell fails; sends pass (exempt skip still applies: fee claims are venue → exempt) |
| 21 | sniper_fee_cap | p0 window s (0 = forever), p1 max priority fee lamports, p2 max Jito tip lamports | buys by plain non-exempt receivers while `now < started_at + p0` (or p0 == 0): fail if the transaction's priority fee > p1 or the sum of its Jito tips > p2. Priority fee = `ceil(SetComputeUnitPrice × limit / 1e6)` with limit = SetComputeUnitLimit, else `min(1 400 000, 200 000 × non-ComputeBudget top-level instructions)`; tips = top-level System transfers to the 8 mainnet tip accounts (inner instructions are not seen). Sells/sends pass |
| 22 | trading_hours | p0 open minute, p1 close minute (1..1440), p2 weekday mask (Mon = bit 0), p3 tz offset minutes + 1440, p4 dst (0 none, 1 US, 2 EU), p5 after-hours mode | local = UTC + offset (+ 60 min while DST is active: US rule in local standard time; EU: last Sunday of March 01:00 UTC → last Sunday of October 01:00 UTC). Open if `p0 < p1`: open ≤ m < close on an allowed weekday; `p1 ≤ p0` (past midnight): m ≥ open on an allowed weekday, or m < close on the day after one. 0 / 1440 = all day. Buys gated always, sells unless p5 == 1, sends pass |
| 23 | resonance | p0 beat s, p1 damping %/s, p2 buy energy %, p3 base bps, p4 floor bps | same decay as momentum; alignment `a = (1 + cos(2π × (elapsed mod p0) / p0)) / 2` (a buy on the beat from the clock start counts fully); kick = `p2/100 × a × min(1, amount / share(supply, p3))`; buy cap = `clamp(p3 × (1 + E), p4, 10000)` |
| 24 | coupled_resonator | p0 period s, p1 coupling %/s, p2 damping %/s, p3 buy energy %, p4 base bps, p5 floor bps | two energies E1, E2: per idle second both decay by p2 and a share `p1/100 × (E1 − E2)/2` flows from the higher to the lower (closed form: the sum decays by `d^dt`, the difference by `(d × (1 − c))^dt`); φ advances with p0; buys kick E1; buy cap = `clamp(p4 × (1 + E1 × sin φ), p5, 10000)` |
| 25 | tithe (Launchpad route) | p0 lamports | buys and sells by plain non-exempt wallets need a top-level System transfer of ≥ p0 lamports to `tithe_recipient` in the same transaction (the largest single transfer counts). Sends pass |
| 26 | fomo_only (App only, v71.35; marks v71.36) | p0..p3 the mark's 32-byte key as four little-endian u64 (`packed_key`; a zero key is refused by `validate_rule`), p4 the mark kind (1 `APP_MARK_PROGRAM`, 2 `APP_MARK_SIGNER`, 3 `APP_MARK_PROGRAM_ACCOUNT`; any other value is refused), p5 the account slot (0–63) for kind 3, 0 otherwise | buys and sells by plain non-exempt wallets pass only when the transaction carries the mark (`sysvar::summarize_with`, top-level instructions only; inner instructions are not seen): kind 1 — an instruction invokes the key's program; kind 2 — the key is a signer of some top-level instruction (meta flag bit 0); kind 3 — an instruction invokes the key's program with account slot p5 present and filled by a key other than the program. Launchpad never builds such a trade. Sends pass |
| 27 | pump_app_only (App only, v71.35; marks v71.36) | as 26 | as 26, for the Pump App's mark. The two app-only rules conflict with each other, the venue rules (12, 19, 20) and every Launchpad-route rule (1, 2, 3, 25) |

State updates (receipt stamps, volume, turn, potato, energy kicks) happen only
when the transfer is not skipped and every check passed; the oscillator decay
and the clock run on every venue transfer. Rules 16, 23 and 24 share the
oscillator fields and are mutually exclusive by the conflict table.

Fixed-point conventions (`osc.rs`): the SIN table has 257 quarter-wave entries in
16.16 (`round(65536 × sin(π/2 × i/256))`, each verified against `f64::sin`
within one unit by `osc::tests::sin_table_matches_f64_sin`), linearly
interpolated to 65536 phase steps per cycle; energies are millionths; decay
factors are 1e12 fixed point raised by squaring.

### The exempt list and graduation

The venue's owner is never an exemption, so listing the DBC pool authority is
harmless but useless. What *does* need an exemption is the owner of the account
that receives the coins at graduation: Meteora moves the base vault into the new
DAMM v2 pool's vault, whose owner is the **DAMM v2 pool authority**
(`deriveDammV2PoolAuthority()` in the SDK) — `exempt[3]`. (Meteora revokes the
hook inside the graduating swap, so this is belt and braces.) Fee claims are
quote-only in Launchpad's config and leftover goes to the leftover receiver
(exempt). Locked vesting is zero in Launchpad's config; if it were ever enabled, the
escrow owner would need an exemption too.

## Error codes

| code | name | meaning |
|---:|---|---|
| 6001–6027 | the rule names (`Allowlist`, `HolderGated`, `HolderVesting`, `AntiDump`, `SlidingCaps`, `GraduatedSellCaps`, `MaxPerWallet`, `RisingMaxPerWallet`, `Chapters`, `TradeGuard`, `AntiBundle`, `VenueLocked`, `MarketHours`, `PingPong`, `BreathingCap`, `Momentum`, `Blocklist`, `HotPotato`, `DexOnly`, `P2pOnly`, `SniperFeeCap`, `TradingHours`, `Resonance`, `CoupledResonator`, `Tithe`, `FomoOnly`, `PumpAppOnly`) | 6000 + rule kind: that rule failed; the text is the catalogue's `rule` sentence |
| 6100 | WalletNotRegistered | a qualifying vesting receipt needs a WalletState that does not exist |
| 6101 | NotAllowed | the signer is not the config's creator |
| 6102 | ConfigMismatch | config missing, malformed, for another mint, or invalid rules / missing gate keys, tithe recipient or swap base amount |
| 6103 | BadAccounts | wrong owner, address, size, signer, writability or account count |
| 6104 | NotTransferring | Execute outside a Token-2022 transfer |
| 6105 | Overflow | checked arithmetic overflowed |
| 6106 | AlreadyInitialized | the account to create already exists |
| 6107 | BlocklistFull | AddBlocked would take the list past 200 wallets |
| 6108 | LaunchStarted | AddBlocked after the first trade |
| 6109 | BadSysvar | the sysvar slot is not the instructions sysvar, or its data is malformed |

Unknown instruction data fails with `InvalidInstructionData`. Names and texts:
`src/errors.rs`; the JS mirror is `HOOK_ERRORS` in `src/hooks/program.mjs`.

## Build

With the owner's platform tools (the same variables `build-fee.sh` uses):

```bash
export LAUNCHPAD_PLATFORM_TOOLS=/path/to/platform-tools   # rust/ and llvm/
export LAUNCHPAD_SBF_SDK=/path/to/sbf-sdk                 # c/sbf.ld
cd contracts/curve-transfer-hook
cargo fetch                                           # once, with network: writes Cargo.lock
bash build-hook.sh                                    # -> artifacts/curve_transfer_hook.so + sha256
```

Or, with the Solana CLI installed: `cargo build-sbf` in this directory
(`target/deploy/curve_transfer_hook.so`). The crate depends on
`solana-program = "=2.3.0"` only; `lib.rs` uses `instruction::get_stack_height`,
the clock and rent sysvars, `system_instruction` and the PDA helpers of that
crate.

## Deploy

```bash
solana-keygen new -o hook-program-keypair.json        # fresh program id; keep it safe
solana program deploy --program-id hook-program-keypair.json artifacts/curve_transfer_hook.so
```

Then set `LAUNCHPAD_HOOK_PROGRAM_ID=<the program id>` in Launchpad's environment. The
feature is off while it is unset; `node scripts/check-hook-readiness.mjs`
reports whether the id is executable on the configured cluster and prints the
derived accounts and list shape for a sample rule set. Try a hooked launch on
devnet first.


**v71.35 / v71.36 (app-only rules).** Rule kinds 26 and 27 and error codes
6026/6027 arrived in v71.35; v71.36 changes what they match: a *mark* (p4 kind,
p5 slot) instead of a bare program id. The reason is what the apps do on
mainnet: FOMO routes hooked coins through an aggregator and signs every trade
with its own co-signer wallet (kind 2), and the Pump App has no program of its
own — it builds an OKX router swap through Jupiter's app API with the router's
commission slot filled (kind 3). A program built from v71.35 reads p4 = p5 = 0
as "program id in p0..p3" and would refuse those trades, and a program from
v71.28–v71.34 refuses the `InitConfig` of any app-only coin with
`ConfigMismatch`. So rebuild and upgrade the deployed program (`cargo test`,
`cargo build-sbf`, `solana program deploy --program-id <the id>` with the
upgrade authority) before setting `LAUNCHPAD_HOOK_FOMO_MARK` /
`LAUNCHPAD_HOOK_PUMP_APP_MARK` in Launchpad's environment (v71.35's
`LAUNCHPAD_HOOK_FOMO_PROGRAM` / `LAUNCHPAD_HOOK_PUMP_APP_PROGRAM` are not read). Every
existing hooked coin keeps working: layouts, PDAs, the TLV shapes of the
existing rules and the codes 6001–6025 are unchanged; no app-only coin can
exist from v71.35, since that version's settings were never meant to be set
before this change.

## Verification

```bash
cargo test                        # host unit tests: every rule boundary, calendar, oscillator, sysvar parser, layouts, TLV bytes, handlers
cargo test --locked --offline     # once Cargo.lock exists
cargo clippy                      # clean at the time of writing
```

`cargo test` needs only the crate registry, not the SBF toolchain. The TLV test
reads `test/fixtures/hook-tlv.json` from the repository root, so run it inside
the repository. On the JS side:

```bash
node --test test/hook-program.test.mjs
node scripts/check-hook-readiness.mjs --offline --rules blocklist,sniper_fee_cap,max_per_wallet
```
