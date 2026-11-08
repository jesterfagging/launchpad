import { createWorkspaceShell } from './workspace-shell.js';
import { createPublicAnalytics } from './analytics-view.mjs';
import { bootPage } from './navigation.mjs';

export function mountPage({ document = globalThis.document, window = globalThis.window } = {}) {
  createWorkspaceShell({ page: 'analytics' });
  const analytics = createPublicAnalytics({ document, window });
  let accountUpdated = false, disposed = false;
  const sessionController = new AbortController();
  const onAccountUpdate = () => { accountUpdated = true; };
  document.addEventListener('curve-account-updated', onAccountUpdate);
  fetch('/api/session', { credentials: 'same-origin', signal: sessionController.signal })
    .then(response => response.ok ? response.json() : { authenticated: false })
    .then(session => { if (!disposed && !accountUpdated && !sessionController.signal.aborted) createWorkspaceShell({ page: 'analytics', session }); })
    .catch(() => {});
  const ready = analytics.load();
  return { ready, destroy() { disposed = true; sessionController.abort(); document.removeEventListener('curve-account-updated', onAccountUpdate); analytics.destroy(); } };
}

bootPage('analytics', mountPage);
