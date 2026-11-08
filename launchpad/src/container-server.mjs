import { launchpadEnv } from './brand-env.mjs';
import { runHost } from './host-server.mjs';

// Keep the historical container bind default without injecting either brand's
// environment aliases, which could conflict with an operator's saved settings.
runHost({ bindAddress: launchpadEnv('BIND_ADDRESS') || '0.0.0.0' }).catch(error => {
  console.error(String(error.message).replace(/(?:https?|wss?):\/\/\S+/g, '[endpoint]'));
  process.exitCode = 1;
});
