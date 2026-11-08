// Settings for the test run (`npm test` loads this before every test file): a platform token, its launch's rewards
// wallet and a manual buyback history, so the token features are exercised. Production hosts set their own (see
// .env.example); without them those features are off.
import { fileURLToPath } from 'node:url';
process.env.LAUNCHPAD_TOKEN_MINT ??= '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc';
process.env.LAUNCHPAD_TOKEN_BURN_WALLET ??= 'Bz3zS37oQ3vm8itxXxsXGJPKyQnHii3xMroaA9hZCwEb';
process.env.LAUNCHPAD_MANUAL_HISTORY_FILE ??= fileURLToPath(new URL('../fixtures/manual-protocol-history/history.json', import.meta.url));
