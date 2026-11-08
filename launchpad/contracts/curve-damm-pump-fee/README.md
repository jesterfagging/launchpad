# Launchpad fee-aware controller for future public PumpSwap launches

> The program ids, operator, treasury and other addresses in this document are placeholders from the open-source
> template, not live deployments. Build and deploy your own and update the pins as described in
> [docs/PROGRAMS.md](../../docs/PROGRAMS.md).

Separate undeployed controller for **$20,000 starting FDV and $50,000 graduation
FDV**. Existing launches keep their original controller and zero-graduation-fee
terms. This executable does not upgrade or mutate that original program.
Ordinary creators can initialize with their own signature and the configured
review relayer; configuration remains administrator-only.

At a $1 reference with six quote decimals:

| Item | Amount |
| --- | ---: |
| Tokens for sale | 700,000,000.055453 |
| Reserved tokens deposited into PumpSwap | 299,999,999.944547 |
| Gross quote principal | 22,135.943622 |
| Treasury graduation fee | 7,135.943625 |
| Net quote deposited into PumpSwap | 14,999.999997 |
| Initial LP value | $29,999.999994 |

The very small departure from exactly 70% sale / 30% reserve results from fixing
the fee fraction to nine decimal places and integer token-unit rounding.

Program: `5F4tt5fQwSR9ymzx5KiYL4Q2Ln8FJxbMfbXD1HhMgUrw`  
ProgramData: `GxZuLjDyHZhDG7vft5uh6UMJfF7pG4a8PZQtEZYcKwTo`  
Program seed: `launchpad-program-3`  
Buffer: `78bmNEEvSsAHCgSNmsVNYM3JpAWLw1y6K4qrxabBCDw2`  
Buffer seed: `launchpad-buffer-3`

Build: `bash build-fee.sh`  
Executable verification: `python3 tests/fee_public_vm.py`

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
