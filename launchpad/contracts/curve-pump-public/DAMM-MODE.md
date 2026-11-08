# Finite DAMM launch and permanent PumpSwap liquidity

> The program ids, operator, treasury and other addresses in this document are placeholders from the open-source
> template, not live deployments. Build and deploy your own and update the pins as described in
> [docs/PROGRAMS.md](../../docs/PROGRAMS.md).

This is an additive controller mode in the isolated deployment `FBD7sVcEMutFtQn6SXGxLZPFLKEY4pbQTkLYTGC9FXKA`. The existing public SOL curve instruction/state namespaces remain unchanged. This mode uses `damm`, `damm-vault`, and `damm-nft` PDA seeds, each followed by the base mint bytes.

The controller initializes one billion plain SPL base tokens with six decimals, revokes mint authority, and puts the sale allocation into a noncompounding DAMM v2 position. It retains the migration base allocation and the position NFT under its system-owned controller PDA. There is no owner withdrawal or arbitrary CPI instruction. Price geometry is calculated onchain with exact integer arithmetic from the signed quote USD snapshot: $20,000 initial FDV and $50,000 terminal FDV using original issued supply. This does not make the quote asset price immutable in USD; subsequent quote USD market changes affect actual USD valuations.

DAMM's fixed fee is 125 basis points, collected only in quote. Creator and holder fee splits are not part of this mode. The controller can claim its position fees only into the immutable protocol treasury's canonical quote ATA. The venue's protocol fee share remains governed by DAMM.

The finite range begins with zero tracked quote principal. DAMM nevertheless requires one real raw unit of quote when creating the pool. Native SOL is wrapped by the controller; other quotes are transferred from the launch payer's canonical ATA. Existing quote donations to the controller can provide this unit. This unit stays separate from principal accounting.

At the exact maximum square-root price, any payer may request graduation. The controller removes only its own saved liquidity, verifies the exact received quote principal, creates an ordinary PumpSwap pool using the saved base reserve and quote principal, and burns all received PumpSwap LP tokens in the same transaction. Failure at any point rolls the entire transaction back. A pool index selects a fresh canonical PumpSwap address; a completed migration records its index and supports idempotent retries. Other DAMM liquidity positions do not prevent graduation and are never withdrawn by this controller.

Quote mint address, token program, decimals, and economics are frozen in launch state. Plain SPL and supported Token-2022 quote mints are checked on every relevant call. Positive transfer fees, active transfer hooks, nontransferability, default frozen accounts, paused transfers, and unknown extensions are rejected. Metadata and issuer authorities do not by themselves disqualify a quote; each canonical venue additionally enforces its own mint and token badge rules.

## Instruction ABI

All integers are little endian. Account zero is the signed transaction payer. JS construction and decoding live in `src/damm-pump-client.mjs` at the app root.

- **6 / initialize**: 89 bytes after opcode: quote USD micro-price u64, expiry timestamp u64, quote decimals u8, minimum sqrt u128, maximum sqrt u128, liquidity u128, sale base u64, reserve base u64, terminal quote u64. Requires the configured relayer signature and exactly 26 accounts.
- **7 / migrate**: PumpSwap pool index u16, exactly 29 accounts. Permissionless; immutable launch state controls all amounts and destinations.
- **8 / claim fees**: no additional data, exactly 21 accounts. Permissionless; destination is the fixed treasury quote ATA.

New state is exactly 512 bytes with `CRVDAMM1` discriminator. Byte432 holds the completed migration pool index. The client contains the complete field offsets and account order.

The initialize transaction temporarily funds the controller with 0.1 SOL plus rent floor for canonical DAMM account setup, then atomically refunds the unused amount above 0.02 SOL plus rent floor to the original payer. The remaining subsidy is only for graduation rent. The actual setup rent and transaction fees are separate from quote principal. Migration can be subsidized by any payer; subsidy does not give reserve rights.
