# Frozen public executable fixtures

These public program executables and the Pump global account were fetched using
finalized, read-only Solana mainnet RPC requests. `manifest.json` records program
addresses, ProgramData addresses, deployment slots, capture slots, and SHA-256
hashes. They contain no wallet credentials. They are third-party programs, not
the Launchpad controller being tested.

Run the offline integration test after building the controller:

```sh
python contracts/curve-pump-public/tests/damm_pump_vm.py
```

The test requires Python `solders` with LiteSVM, Node, and the app's installed
dependencies. `DAMM_CONTROLLER_BINARY` can override the controller ELF path;
`DAMM_VM_REPORT` can override the JSON report path. Tests load these frozen
fixtures and use deterministic synthetic keys/balances. They never contact RPC
or broadcast a transaction. Only the fixture admin configuration transaction
disables cryptographic signature verification; all user and relayer transactions
use signed test keypairs.

The suite exercises actual DAMM initialization, repeated public buy/sell swaps,
quote-only protocol fee claims, terminal partial fills, actual PumpSwap pool
creation, and the burn of every received Pump LP token. It also covers native
SOL, ordinary SPL quotes, plain Token-2022 quotes, the two permitted metadata
extensions, quote precision extremes, foreign-account substitution, stale
relayer/price authorization, unsupported extensions, custody donations,
permissionless graduation, and recovery using a fresh PumpSwap index.

After migration, `damm_pump_trade_fixture.mjs` calls the production
`DammPumpClientAdapter.pumpTrade` method with the VM account snapshot. Its SDK
instructions are executed against the actual PumpSwap and fee programs. Both
buy and sell must deliver the reviewed minimum output, debit the intended
input, and leave LP burned. SOL trades must preserve preexisting wrapped SOL and
close their own temporary accounts. `pump-trading-config.json` supplies the
frozen public fee configuration and volume accumulator used for these checks.

Failures are checked against byte-for-byte snapshots of custody and token
accounts. A compute-budget failure occurs inside actual DAMM initialization;
a disabled PumpSwap instruction fails after the DAMM withdrawal. Both must
restore all principal and allow a safe retry. Transaction fee debits are excluded
from these snapshots. Compute use is measured in the JSON report. Its legacy
harness packet lengths do not replace the separate production v0/lookup-table
packet tests, which include mint and metadata setup.

`controller-initialized.json`, when present, is a synthetic account snapshot
produced by setting `DAMM_CAPTURE_INITIALIZED`. It is not a mainnet launch and
contains no user assets or credentials. Its controller hash identifies the ELF
used to create it.

To intentionally refresh the public fixture snapshot, run
`python contracts/curve-pump-public/tests/capture_damm_programs.py`. This separate
capture helper supports only `getGenesisHash` and `getMultipleAccounts`; it cannot
sign or submit transactions. Refreshing fixtures changes the programs under test
and requires rerunning and reviewing the integration results.
