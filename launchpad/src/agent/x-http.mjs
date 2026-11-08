// AI influencer (v71.30): HTTP routes of the X account connection. Called by src/account-app.mjs for every
// request whose path starts with /api/launchpad/x/ with ctx = { req, res, path, url, ip, send, limits, accounts,
// cookieToken, csrfSession, bodyJson, agents, origin, configured }; returns true for every such path (404 JSON
// for unknown sub-paths) and false for anything else. Trust boundary: the cookie session names the Launchpad
// account; the fetch() routes (GET /connect, GET /accounts, POST /disconnect) also need the x-control-token
// CSRF header except the read-only account list; GET /callback is a browser navigation from X without that
// header, so the creator is identified by the state row, which must match the cookie session. The session
// cookie is SameSite=Strict, so the cross-site hop from x.com arrives without it: that hop is answered with a
// one-line HTML page whose meta refresh re-requests the same URL (`hop=1`) from our own origin, where the
// cookie is sent; only then is the state checked against the session and the code exchanged. Answers JSON
// through ctx.send(), redirects through res.writeHead(302), never echoes the authorization code or a token
// anywhere but in that same-URL hop, and turns any error without a statusCode into one generic sentence.
import { X_STATE_EXPIRED } from './x-accounts.mjs';

const PREFIX = '/api/launchpad/x/', ACTIONS = Object.freeze(['connect', 'callback', 'accounts', 'disconnect']);
export const X_HTTP_GENERIC = 'The X connection could not be completed. Try again shortly.';
const safeMessage = error => error?.statusCode ? String(error.message || X_HTTP_GENERIC).replace(/(?:https?|wss?):\/\/\S+/g, '[link]').slice(0, 240) : X_HTTP_GENERIC;
const RETURN_TO = /^coin:([1-9A-HJ-NP-Za-km-z]{32,44})$/;

/**
 * Where the browser goes after the callback, with the outcome in the hash:
 * '/launchpad#x-connected=<id>' | '/launchpad#x-error=<message>' | '/coin?mint=<mint>#agent&x-connected=<id>' | '/coin?mint=<mint>#agent&x-error=<message>'.
 */
export function xReturnLocation(returnTo, { connected = '', error = '' } = {}) {
  const match = RETURN_TO.exec(String(returnTo || ''));
  const base = match ? `/coin?mint=${encodeURIComponent(match[1])}#agent&` : '/launchpad#';
  return base + (connected ? `x-connected=${encodeURIComponent(connected)}` : `x-error=${encodeURIComponent(String(error || X_HTTP_GENERIC).slice(0, 160))}`);
}

export async function handleXRoutes(ctx) {
  const { req, res, path, url, ip, send, limits, cookieToken, csrfSession, bodyJson, agents } = ctx;
  if (!path.startsWith(PREFIX)) return false;
  const action = path.slice(PREFIX.length);
  try {
    if (!ACTIONS.includes(action)) { send(404, { error: 'Not found.' }); return true; }
    if (req.method !== (action === 'disconnect' ? 'POST' : 'GET')) { send(405, { error: 'Method not allowed.' }); return true; }
    if (!agents?.xAccounts) { send(503, { error: 'X account connection is not available on this host.' }); return true; }
    const token = cookieToken(req), csrf = String(req.headers['x-control-token'] || '');
    const checked = token ? await csrfSession(token, csrf) : { session: null, csrfValid: false }, session = checked.session;
    const key = session ? `account:${session.account.id}` : `ip:${ip}`;
    if (action === 'callback') { await callback(ctx, session); return true; }
    if (action === 'accounts') {
      limits.check(`x-accounts:${key}`, 60);
      if (!session) { send(401, { error: 'Sign in to see your X accounts.' }); return true; }
      if (!agents.available()) { send(200, { accounts: [], available: false, at: Date.now() }); return true; }
      await agents.ensure();
      send(200, { accounts: agents.xAccounts.list(session.account.id), available: agents.xAccounts.available(), at: Date.now() }); return true;
    }
    limits.check(`x-${action}:${key}`, 10);
    if (!session) { send(401, { error: 'Sign in to connect an X account.' }); return true; }
    if (!checked.csrfValid) { send(403, { error: 'Refresh this page to reconnect.' }); return true; }
    const accountId = session.account.id;
    await agents.ensure();
    // The session is checked again after the work, like the other creator routes: a sign-out in between is not answered.
    const recheck = async () => { const again = await csrfSession(token, csrf); if (!again.session || again.session.account.id !== accountId || !again.csrfValid) throw Object.assign(Error('Sign in again before changing X accounts.'), { statusCode: 401 }); };
    if (action === 'connect') { const result = await agents.xAccounts.connectUrl({ accountId, returnTo: url.searchParams.get('returnTo') || 'launchpad' }); await recheck(); send(200, result); return true; }
    let body; try { body = await bodyJson(req, { maxBytes: 4096 }); } catch (error) { throw Object.assign(error, { statusCode: error.statusCode || 400 }); }
    const accounts = await agents.xAccounts.disconnect({ accountId, xAccountId: String(body.xAccountId || '') }); await recheck(); send(200, { accounts }); return true;
  } catch (error) {
    const retryAfterMs = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0 ? Math.min(900000, Math.round(error.retryAfterMs)) : null;
    if (retryAfterMs && typeof res.setHeader === 'function' && !res.headersSent) res.setHeader('retry-after', String(Math.ceil(retryAfterMs / 1000)));
    send(error?.statusCode || 500, { error: safeMessage(error), ...(retryAfterMs ? { retryAfterMs } : {}) });
  }
  return true;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
/** The same-origin hop: a static page (no script, no style) whose meta refresh re-requests this URL with hop=1 from our own origin. */
export function xHopPage(url) {
  const target = new URL(url); target.searchParams.set('hop', '1'); const href = escapeHtml(target.pathname + target.search);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${href}"><title>Connecting X…</title></head><body><p>Finishing the X connection… <a href="${href}">Continue</a></p></body></html>`;
}

/** GET /callback?code&state (or ?error when the user denied): finishes the connection and redirects with the outcome in the hash. */
async function callback(ctx, session) {
  const { res, url, ip, limits, agents } = ctx;
  limits.check(`x-callback:${ip}`, 20);
  const redirect = location => { res.writeHead(302, { location }); res.end(); };
  const state = String(url.searchParams.get('state') || ''), code = String(url.searchParams.get('code') || ''), denied = String(url.searchParams.get('error') || '');
  if (!agents.available()) return redirect(xReturnLocation('launchpad', { error: 'X account connection is not available right now.' }));
  await agents.ensure();
  const pending = agents.xAccounts.peekState(state);
  if (!pending) return redirect(xReturnLocation('launchpad', { error: X_STATE_EXPIRED }));
  if (!session && !url.searchParams.has('hop')) { const page = xHopPage(url); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(page) }); res.end(page); return; }
  if (!session || session.account.id !== pending.accountId) return redirect(xReturnLocation(pending.returnTo, { error: 'Sign in to the Launchpad account that started this connection, then try again.' }));
  if (denied || !code) { agents.xAccounts.consumeState(state); return redirect(xReturnLocation(pending.returnTo, { error: denied === 'access_denied' ? 'You declined the connection on X.' : 'X did not authorize the connection.' })); }
  try { const result = await agents.xAccounts.callback({ code, state }); return redirect(xReturnLocation(result.returnTo, { connected: result.xAccountId })); }
  catch (error) { return redirect(xReturnLocation(pending.returnTo, { error: safeMessage(error) })); }
}
