import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHost } from './host-server.mjs';
export { createApp } from './app.mjs';
export { createAccountApp } from './account-app.mjs';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHost({ openBrowser: process.argv.includes('--open') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
