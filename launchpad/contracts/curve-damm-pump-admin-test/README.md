# Launchpad owner-only fee-aware test controller

> The program ids, operator, treasury and other addresses in this document are placeholders from the open-source
> template, not live deployments. Build and deploy your own and update the pins as described in
> [docs/PROGRAMS.md](../../docs/PROGRAMS.md).

Separate undeployed controller for **$50 starting FDV and $100 graduation FDV**.
It does not upgrade or replace the existing public controller. Initialization
requires the fixed administrator `7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS`
to sign as payer, plus the configured review relayer. The resulting pools are
public and tradable; mainnet tests still use real SOL and quote assets.

At a $1 reference with six quote decimals:

| Item | Amount |
| --- | ---: |
| Tokens for sale | 676,060,562.607558 |
| Reserved tokens deposited into PumpSwap | 323,939,437.392442 |
| Gross quote principal | 47.804700 |
| Treasury graduation fee | 15.410756 |
| Net quote deposited into PumpSwap | 32.393944 |
| Initial LP value | $64.787888 |

Program: `CzgJRVKJSmAibnZAjkEYqmAVvxyCSSukjxNG2y7b62NU`  
ProgramData: `8kvT3drS36j6qaMie5j2HgqLDMfxLbdLqPsy75VASrc4`  
Program seed: `launchpad-program-4`  
Buffer: `6GDnbt3ZP3z8uLUS3E9z2PZJjMV2iDUtFBDUp5B6oe4h`  
Buffer seed: `launchpad-buffer-4`

Build: `bash build-admin-test.sh`  
Executable verification: `python3 tests/admin_test_vm.py`

The controller starts a finite DAMM v2 concentrated-liquidity pool, retains the
migration base reserve, and allows permissionless graduation only when the actual
DAMM price reaches its fixed endpoint. Graduation atomically withdraws gross
quote principal, sends its fixed fee to the public Launchpad treasury, seeds an
ordinary PumpSwap pool with net quote and every reserved base token, and burns
all received LP tokens. Any failure rolls back the entire transaction.

The immutable fee is `floor(gross_quote * 322369073 / 1000000000)`, approximately
32.2369073%. Initial sale/reserve allocation accounts for that fee, preserving the
endpoint price and the initially issued one-billion-token supply. Graduation
does not burn base tokens. Independent holders can still burn their own tokens;
that must not block graduation. Swap fees and unsolicited donations are excluded
from graduation principal. Only unsolicited donations can remain in custody.

The fee is paid to the canonical quote-token ATA of
`HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF`. SOL-quoted fees are received as
wrapped SOL. Neither the caller nor the relayer can choose a fee recipient or
amount. The existing quote-only 1.25% DAMM trading fee remains separate.

Opcode 7 uses the original 29 migration accounts plus treasury at index 29 and
its writable quote ATA at index 30. The final fee paid is recorded at state
byte offset 440 (u64). Offset 336 records gross expected quote, offset 408 the
net migrated quote, and offset 416 migrated base. Successful migration retries
are idempotent and never pay the fee again. Legacy launch/trade opcodes are
explicitly disabled; initialize, configure, graduate and claim fees remain.

USD amounts use the launch's reviewed quote/USD reference. Coarse quote units
that cannot preserve price within five basis points are rejected.

## Offline verification

`release.json` pins the executable, source hashes, deployment addresses, and
successful checks. The SBF builder uses the existing platform-tools and SBF SDK
through `LAUNCHPAD_PLATFORM_TOOLS` and `LAUNCHPAD_SBF_SDK`. `cargo test --locked --offline`
checks exact Rust arithmetic against the pinned DAMM SDK vectors.

The executable suite uses the same hash-pinned actual DAMM, PumpSwap and Pump
fee executables as the existing public controller's offline harness. No RPC,
broadcasts or real funds are used. Configuration and permitted administrator
initialization fixtures deliberately disable signature verification because the
real administrator's private key is unavailable. All ordinary-user, relayer and
keeper transactions use real deterministic test-key signatures. Forged admin
signatures are separately rejected with verification enabled.
