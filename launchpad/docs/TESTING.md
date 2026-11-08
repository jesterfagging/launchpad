# Tests

```bash
npm ci          # includes the dev dependencies the page tests use (linkedom, esbuild)
npm test
```

`npm test` runs every `test/*.test.mjs` with Node's built-in runner. It needs no network, RPC, wallet or keys: chain
calls are replaced by recorded fixtures and fakes. To run one file:

```bash
node --import ./test/support/env.mjs --test test/launchpad.test.mjs
```

`test/support/env.mjs` gives the run a platform token and a manual buyback history so the token features are tested.
Your server never reads it.

## Skipped suites

Some suites check the exact binary of a program build or a captured third-party program. Those files are not in the
repository, so the suites are skipped with a note saying which file is missing:

| Suite | Needs |
|---|---|
| `pump-public-deployment*`, `damm-pump-deployment*`, `damm-pump-fee-deployment*`, `damm-pump-test-deployment*` | Your program builds in `private/` (see [PROGRAMS.md](PROGRAMS.md)) |
| `pump-test-deployment` | `PUMP_TEST_DEPLOYMENT_BINARY` pointing at your owner build |
| `damm-pump-venue-proof` | The venue programs captured by `contracts/curve-pump-public/tests/capture_damm_programs.py` |
| `pump-private-test-client`, `pump-funded-adapter-security` | A captured Pump program at `private/pump-mainnet.so` and the owner build |

The deployment suites check the pins in `src/*-deployment.mjs` against the binary, so they pass only with the build
the pins describe.

## Program tests

- Solana programs: the Python LiteSVM tests in `contracts/*/tests/` (see [PROGRAMS.md](PROGRAMS.md#building-the-solana-programs)).
- Robinhood Chain contracts: `forge test` in `contracts/curve-launch-evm` after `node scripts/vendor-v4-core.mjs`.

## Looking at the pages without a server

`preview/` serves every page with mock data, no chain and no keys:

```bash
node preview/server.mjs        # then open the address it prints
```

Use it to check a design change on desktop and phone sizes before you deploy.
