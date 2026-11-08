# Third-party notices

The project's own code is under the MIT license (`LICENSE`). These files in the repository come from other projects
and keep their own licenses. Each license text sits next to the files it covers.

| Files | Project | License |
|---|---|---|
| `public/fonts/BricolageGrotesque-*` | Bricolage Grotesque | SIL Open Font License 1.1 (`BricolageGrotesque-LICENSE.txt`) |
| `public/fonts/Fredoka*` | Fredoka | SIL Open Font License 1.1 (`Fredoka-LICENSE.txt`) |
| `public/fonts/GeistMono-*` | Geist Mono | SIL Open Font License 1.1 (`GeistMono-LICENSE.txt`) |
| `public/fonts/InterVariable.woff2` | Inter | SIL Open Font License 1.1 (`Inter-LICENSE.txt`) |
| `public/fonts/LilitaOne*` | Lilita One | SIL Open Font License 1.1 (`LilitaOne-LICENSE.txt`) |
| `public/vendor/lightweight-charts.mjs` | TradingView Lightweight Charts | Apache License 2.0 (`lightweight-charts-LICENSE.txt`, `lightweight-charts-NOTICE.txt`) |
| `public/vendor/solana-transaction.mjs` | `@solana/web3.js` bundle (VersionedTransaction only) and its dependencies | MIT and others, listed in `solana-transaction-LICENSE.txt` and `solana-transaction-NOTICE.txt` |
| `vendor/bigint-buffer/`, `vendor/launchpad-bigint-buffer-js-1.0.0.tgz` | Derived from bigint-buffer 1.1.5 (pure JavaScript part) | Apache License 2.0 (`vendor/bigint-buffer/LICENSE`, `NOTICE.md`) |
| `vendor/pump-idl/pump-classic-idl.json` | Subset of Pump's public Anchor IDLs (`scripts/vendor-pump-idl.mjs` records the source) | See the source repository |
| `contracts/curve-launch-evm/src/lib/V4Math.sol`, `src/interfaces/IUniswapV4.sol` | Arithmetic and the interface slice of Uniswap v4 (re-implemented with the same constants) | MIT (file headers) |

Uniswap v4 core itself is not in this repository; `contracts/curve-launch-evm/scripts/vendor-v4-core.mjs` fetches it for
the Foundry tests under Uniswap's own license.

## Token logos and names

`public/quote-logos/` holds the logos of tokens that can be used as a coin's pair (SOL, USDC, tokenized stocks, memecoins
and others), named by mint address. They are the trademarks and artwork of their issuers and are included only to show
which token a pair uses. Replace or remove any you do not have the right to show.

## Dependencies

npm packages (`package.json`, `package-lock.json`) are installed from the npm registry under their own licenses. Run
`npx license-checker --production` after `npm ci` for a full list.
