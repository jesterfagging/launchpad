// AI influencer (Launchpad v71.30): HTTP routes of the influencer card, the creator controls, reference
// uploads and the generated media files. Called by src/account-app.mjs for every path starting with
// /api/launchpad/agents/influencer or /influencer-media/ with
// ctx = { req, res, path, url, ip, send, limits, accounts, cookieToken, csrfSession, bodyJson, agents, origin, configured }.
// Returns true when it answered the request, false to let the server 404. Sessions and CSRF are checked
// here with the helpers the server passes; errors become { error } with the error's own status for the
// service's statusCode errors and a generic sentence otherwise (never provider text, paths or ids).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const MEDIA_ROUTE = /^\/influencer-media\/([a-f0-9]{24})\/((?:master|sheet|[a-f0-9]{24})\.(?:png|jpg|webp|mp4))$/;
const TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4' });
const GENERIC = 'The influencer service is unavailable right now.';
const safeMessage = error => (error?.statusCode ? String(error.message || GENERIC).replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 240) : GENERIC);
const sendError = (ctx, error) => { if (error?.rateWindow === true) throw error; ctx.send(error?.statusCode || 500, { error: safeMessage(error) }); return true; };

/** The signed-in session of the request and whether its CSRF header matches. */
async function sessionOf(ctx) {
  const token = ctx.cookieToken(ctx.req);
  const checked = token ? await ctx.csrfSession(token, String(ctx.req.headers['x-control-token'] || '')) : { session: null, csrfValid: false };
  return { token, session: checked?.session || null, csrfValid: checked?.csrfValid === true };
}
/** Re-authorizes the creator after every read (the pattern of the agent creator routes): same account, valid CSRF. */
function creatorContext(ctx, token, accountId) {
  return { sessionToken: token, authorize: async () => { const verification = await ctx.csrfSession(token, String(ctx.req.headers['x-control-token'] || '')), current = verification?.session; if (!current || current.account.id !== accountId) throw Object.assign(Error('Sign in again before changing your agent.'), { statusCode: 401 }); if (verification.csrfValid !== true) throw Object.assign(Error('Refresh this page to reconnect.'), { statusCode: 403 }); return current; } };
}

export async function handleInfluencerRoutes(ctx) {
  const { req, res, path, url, ip, send, limits, accounts, agents } = ctx;
  const media = MEDIA_ROUTE.exec(path);
  if (media) {
    // Generated media stays readable even when the flag is off (existing posts keep their pictures); hidden or archived agents 404.
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, { error: 'Method not allowed.' }); return true; }
    try {
      limits.check(`influencer-media:${ip}`, 300);
      await agents.ensure();
      const agent = agents.store().agent(media[1]);
      if (!agent || agent.hidden || agent.archived) { send(404, { error: 'Not found.' }); return true; }
      const file = agents.influencer.mediaPath(media[1], media[2]); if (!file) { send(404, { error: 'Not found.' }); return true; }
      const info = await stat(file);
      res.writeHead(200, { 'content-type': TYPES[media[2].split('.').pop()] || 'application/octet-stream', 'content-length': info.size, 'cache-control': 'public, max-age=3600', 'accept-ranges': 'none' });
      if (req.method === 'HEAD') { res.end(); return true; }
      await new Promise(resolve => { const stream = createReadStream(file); stream.on('error', () => { res.destroy(); resolve(); }); res.on('close', resolve); stream.pipe(res); });
      return true;
    } catch (error) { return sendError(ctx, error); }
  }
  if (path.startsWith('/influencer-media/')) { send(404, { error: 'Not found.' }); return true; }
  if (!path.startsWith('/api/launchpad/agents/influencer')) return false;
  try {
    if (path === '/api/launchpad/agents/influencer' && req.method === 'GET') {
      // Public card; a verified viewer keeps its own allowance behind a shared NAT.
      const token = ctx.cookieToken(req), viewer = token ? await accounts.getSession(token) : null;
      limits.check(`agents-influencer:${viewer ? `account:${viewer.account.id}` : `ip:${ip}`}`, 120);
      await agents.ensure();
      const agent = agents.views.requireAgent(url.searchParams.get('mint'));
      send(200, { influencer: agents.influencer.view(agent), at: Date.now() });
      return true;
    }
    if (path === '/api/launchpad/agents/influencer' || path === '/api/launchpad/agents/influencer/reference') {
      if (req.method !== 'POST') { send(405, { error: 'Method not allowed.' }); return true; }
      const { token, session, csrfValid } = await sessionOf(ctx);
      if (!session) { send(401, { error: 'Sign in first.' }); return true; }
      if (!csrfValid) { send(403, { error: 'Refresh this page to reconnect.' }); return true; }
      await agents.ensure();
      if (path.endsWith('/reference')) {
        limits.check(`agents-influencer-reference:${session.account.id}`, 10, 300000);
        const body = await ctx.bodyJson(req, { maxBytes: 2200000, sizeMessage: 'The reference image is too large (1.5 MB at most).' });
        send(200, await agents.influencer.storeReference(session.account.id, body?.data));
        return true;
      }
      limits.check(`agents-influencer-control:${session.account.id}`, 30);
      const body = await ctx.bodyJson(req, { maxBytes: 16384 });
      send(200, { influencer: await agents.influencer.control(session, body || {}, creatorContext(ctx, token, session.account.id)), at: Date.now() });
      return true;
    }
    send(404, { error: 'Not found.' });
    return true;
  } catch (error) { return sendError(ctx, error); }
}
