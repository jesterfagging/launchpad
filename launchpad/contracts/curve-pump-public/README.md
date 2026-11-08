# Launchpad public SOL launch program

> The program ids, operator, treasury and other addresses in this document are placeholders from the open-source
> template, not live deployments. Build and deploy your own and update the pins as described in
> [docs/PROGRAMS.md](../../docs/PROGRAMS.md).

This program implements $20,000 starting FDV / $50,000 graduation FDV using a SOL/USD snapshot signed by the configured relayer. Actual USD values move if SOL/USD moves; the snapshot never reprices a running curve. Launches mint one billion classic SPL tokens with six decimals, revoke mint authority, and have no freeze authority, transfer tax or holder rewards.

The per-mint `vault` PDA is the reserve authority and PumpSwap pool creator. The separate platform relayer submits graduation and pays the transaction fee. The launch creator never receives or burns LP. A single instruction creates the canonical PumpSwap pool, verifies exact reserves, burns all LP received by the vault, verifies that burn, and pays the fixed 28.85% graduation fee. Transaction failure rolls back the entire migration. Launchpad trades pay 1% to the fixed protocol treasury and 0.5% to the immutable launch creator. Creator fees are paid automatically; small payouts to an empty wallet accrue in the program state until rent-safe, then settle to the original creator. Permissionless settlement cannot redirect them. Creator fees end at graduation. No reserve withdrawal instruction exists.

## Authorities

The fixed admin `7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS` can rotate the relayer or enable/disable new launches. Disabling new launches does not disable buys, sells, or migration for existing launches. The relayer co-signs initialization to attest a fresh SOL/USD snapshot and submits migrations. It cannot change supply, allocation, fees, or treasury. The upgradeable loader authority remains a separate trust boundary; an upgrade authority can replace program code.

Treasury: `HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF`.
Public program: `458mQ1YveCRQQQqnR4kBUyRGXwqmJ8EuybKcUKRc2L6C`.

## ABI

`src/pump-public-client.mjs` supplies address derivation and instructions. State uses `curve + mint` seeds (320 bytes); reserve authority uses `vault + mint`; singleton configuration uses `config` (128 bytes). Instruction opcodes: initialize 0; buy 1; sell 2; migrate 3; configure 4. There is no withdrawal opcode.

Initialization requires the creator and configured relayer, uses a 300-second maximum expiry, and enforces the fixed public economics. The launch transaction creates immutable Metaplex metadata, hands mint authority to the vault, then mints and revokes authority atomically. Metadata fields: name up to 32 UTF-8 bytes, ticker up to 10, HTTPS metadata URI up to 200.

Trade instructions accept any signing holder with their own token account. The final buy is clipped to the remaining allocation. Sells are allowed while graduation is awaiting retry, reopening the curve; they are serialized against migration by Solana account locks. After migration, trading happens on PumpSwap.

## Recovery

Retries of the recorded completed migration are no-ops. A dusted future pool cannot change the opening price; the relayer may select another canonical pool index. Sells remain available until migration actually commits. Native SOL donations to the vault WSOL ATA are synchronized before balances are checked and do not become curve principal. Unsolicited assets and unused rent remain in program custody without an admin withdrawal path.

Migration is not autonomous on chain: the relayer needs a running service, RPC access and SOL for network fees. Admin rotation recovers a failed relayer. Program and external PumpSwap upgrades require verification. This implementation has automated actual-executable tests and independent internal review, not a professional security audit or a guarantee against all exploits.

## Build and verification

Use Solana platform tools v1.57 and sbf-sdk v4.3.0:

```
LAUNCHPAD_PLATFORM_TOOLS=/path/to/platform-tools LAUNCHPAD_SBF_SDK=/path/to/sbf-sdk bash build-public.sh
```

The pinned lockfile and release overflow checks are mandatory. Tests run with `solders`/LiteSVM and captured mainnet PumpSwap/Metaplex executables. They do not broadcast or use real funds. `public_vm.py` uses real fixture signatures for creator, trader and relayer transactions; only the fixed-admin configuration fixture bypasses cryptographic signature verification because no mainnet private key is held. Runtime instruction authorization is still exercised.

Reports: `public-vm-results.json`, `metadata-security-results.json`, `adversarial-security-results.json`.
