import { MAX_WALLETS } from '../public/wallet-limits.mjs';
import { requireLive } from './live-settings.mjs';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseWallet, invariant } from './core.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = join(root, 'public');
function equalSecret(supplied, expected) {
  const a = Buffer.from(String(supplied || '')), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function createApp(engine, controlToken = randomBytes(32).toString('hex'), { accessToken = '', portfolio = null } = {}) {
  // Native background controls cover whichever tab owns the active run.
  // Keep the copytrading endpoints scoped to copytrading for existing clients.
  const runtimeStatus = () => {
    const selected = portfolio && portfolio.state !== 'stopped' ? portfolio : engine;
    const status = selected.status('live');
    return { state: status.state, mode: status.mode, kind: selected === portfolio ? status.kind : 'copy', streamConnected: !!status.streamConnected };
  };
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const host = req.headers.host;
    const headers = {
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      // Exact built-in Lightweight Charts attribution CSS; no general inline-style permission.
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    };
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)); };
    try {
      if (!allowedHosts.has(host)) return send(403, { error: 'Use the localhost address printed by this app.' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(403, { error: 'Cross-origin request refused.' });
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return send(403, { error: 'Cross-site request refused.' });
      // Android's loopback interface is shared by apps. Only this APK receives this
      // random capability through its private service and HttpOnly WebView cookie.
      if (accessToken) {
        const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('launchpad-access='))?.slice('launchpad-access='.length);
        if (!equalSecret(req.headers['x-app-token'] || cookie, accessToken)) return send(403, { error: 'Open Launchpad from its Android app.' });
      }
      const path = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && path === '/api/session') return send(200, { token: controlToken, ...(portfolio ? { portfolio: true } : {}) });
      if (path.startsWith('/api/')) {
        const supplied = String(req.headers['x-control-token'] || '');
        if (!equalSecret(supplied, controlToken)) return send(403, { error: 'Refresh this local page to reconnect.' });
        if (req.method === 'GET' && path === '/api/status') return send(200, engine.status('live'));
        if (req.method === 'GET' && path === '/api/runtime/status') return send(200, runtimeStatus());
        if (req.method === 'GET' && path === '/api/portfolio/status' && portfolio) return send(200, portfolio.status(new URL(req.url, `http://${host}`).searchParams.get('mode') || 'live'));
        if (req.method === 'GET' && path === '/api/events' && engine.on) {
          res.writeHead(200, { 'content-type':'text/event-stream', 'connection':'keep-alive' });
          let timer, blocked = false;
          const flush = () => {
            clearTimeout(timer); timer = null;
            if (!res.destroyed && !blocked) blocked = !res.write(`data: ${JSON.stringify(engine.status('live'), (_, v) => typeof v === 'bigint' ? v.toString() : v)}\n\n`);
          };
          const changed = () => { if (!timer && !blocked) timer = setTimeout(flush, 25); };
          res.on('drain', () => { blocked = false; changed(); });
          const heartbeat = setInterval(flush, 15000);
          engine.on('change', changed);
          res.on('close', () => { clearTimeout(timer); clearInterval(heartbeat); engine.off('change', changed); });
          flush(); return;
        }
        if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(415, { error: 'Expected JSON.' });
        let length = 0, chunks = [];
        for await (const chunk of req) { length += chunk.length; if (length > 262144) { send(413, { error: 'Input too large.' }); req.destroy(); return; } chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, { error: 'Invalid JSON input.' }); }
        chunks = [];
        if (path === '/api/start') {
          requireLive(body);
          invariant(!portfolio || portfolio.state === 'stopped', 'Stop the active portfolio strategy first.');
          if (portfolio && body.mode === 'live') {
            const addresses = (body.wallets || []).map((w, i) => parseWallet({ ...w }, i, 'live').publicKey);
            invariant(!portfolio.ledgers.live.data.lots.some(r => addresses.includes(r.wallet)), 'Release this wallet’s portfolio allocation before using it for copytrading.');
          }
          try { return send(200, await engine.start(body)); }
          catch (error) {
            return send(400, { error: String(error.message || 'Start failed.').replace(/https?:\/\/\S+/g, '[provider]').slice(0, 300), status: engine.status('live') });
          }
        }
        if (path === '/api/stop') return send(200, engine.stop());
        if (path === '/api/manual-trade') {
          requireLive(body.config);
          invariant(!portfolio || portfolio.state === 'stopped', 'Stop the active portfolio strategy before manual trading.');
          if (portfolio) {
            const mode = engine.state === 'running' ? engine.status('live').mode : body.config?.mode;
            invariant(mode === 'live', 'Live trading is required.');
            const selected = new Set(body.trade?.wallets || []), data = portfolio.ledgers[mode].data;
            invariant(!data.lots.some(row => selected.has(row.wallet)) && !data.pending.some(row => selected.has(row.wallet)), 'Release the selected wallets’ portfolio allocations and reconcile pending transactions before manual trading.');
          }
          try { return send(200, await engine.manualTrade(body.config, body.trade)); }
          catch (error) { return send(400, { error: String(error.message || 'Manual trade failed.').replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 300), status: engine.status('live') }); }
        }
        if (path === '/api/runtime/stop') { engine.stop(); portfolio?.stop(); return send(200, runtimeStatus()); }
        if (portfolio && path.startsWith('/api/portfolio/')) {
          if (path === '/api/portfolio/stop') return send(200, portfolio.stop());
          if (path === '/api/portfolio/start') {
            requireLive(body.config);
            invariant(engine.state === 'stopped', 'Stop copytrading before starting a portfolio strategy.');
            if (body.config?.mode === 'live') {
              const addresses = (body.config.wallets || []).map((w, i) => parseWallet({ ...w }, i, 'live').publicKey);
              invariant(!engine.ledgers.live.data.pending.some(p => addresses.includes(p.wallet)) && !engine.ledgers.live.data.lots.some(l => addresses.includes(l.wallet) && BigInt(l.remaining) > 0n), 'These wallets have copied positions or pending trades. Use separate wallets for this strategy.');
            }
            try { return send(200, await portfolio.start(body.config, body.kind)); }
            catch (error) { return send(400, { error: String(error.message).replace(/https?:\/\/\S+/g, '[provider]').slice(0, 300), status: portfolio.status() }); }
          }
          if (path === '/api/portfolio/withdraw') { requireLive(body.config); invariant(engine.state === 'stopped', 'Stop copytrading before withdrawing liquidity.'); return send(200, await portfolio.withdraw(body.wallet, body.config)); }
          if (path === '/api/portfolio/release') return send(200, await portfolio.release(body.id, body.mode));
        }
        if (path === '/api/wallets') {
          requireLive(body);
          invariant(Array.isArray(body.wallets) && body.wallets.length <= MAX_WALLETS, `Maximum ${MAX_WALLETS} wallets.`);
          const wallets = body.wallets.map((row, i) => { const w = parseWallet(row, i, body.mode); return { publicKey: w.publicKey, label: w.label }; });
          return send(200, { wallets });
        }
        return send(404, { error: 'Unknown action.' });
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/run-ui.js': ['run-ui.js', 'text/javascript'], '/run-settings.mjs': ['run-settings.mjs', 'text/javascript'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/presets.mjs': ['presets.mjs', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.ico': ['favicon.ico', 'image/x-icon'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] };
      for (const name of ['wallet-limits.mjs', 'sniper-settings.mjs', 'liquidity-plans.mjs', 'run-settings.mjs', 'run-ui.js', 'portfolio-ui.js', 'strategy-settings.mjs', 'account-ui.js', 'account-security-ui.js', 'trading-ui.js']) files['/' + name] = [name, 'text/javascript; charset=utf-8'];
      for (const name of ['terminal-ui.js', 'market-chart.js', 'workspace-shell.js', 'ui-performance.mjs', 'execution-presets.mjs', 'execution-presets-ui.js', 'account-connections-ui.js', 'connection-fields.mjs', 'tool-layout-ui.js', 'chains.mjs', 'vendor/lightweight-charts.mjs']) files['/' + name] = [name, 'text/javascript; charset=utf-8'];
      for (const name of ['terminal.css', 'workspace.css', 'dashboard.css', 'robinhood.css']) files['/' + name] = [name, 'text/css; charset=utf-8'];
      for (const name of ['solana-chain.svg', 'robinhood-chain.svg']) files['/' + name] = [name, 'image/svg+xml'];
      files['/curve-theme.css']=['curve-theme.css','text/css'];
      files['/coin-image.mjs']=['coin-image.mjs','text/javascript'];
      for (const name of ['brand-icon.svg','brand-logo.svg','brand-icon.png','brand-avatar.png','brand-avatar.jpg']) files['/'+name]=[name,name.endsWith('.svg')?'image/svg+xml':name.endsWith('.jpg')?'image/jpeg':'image/png'];
      files['/trade']=files['/'];
      if (req.method !== 'GET' || !files[path]) return send(404, { error: 'Not found.' });
      const [name, type] = files[path]; res.writeHead(200, { 'content-type': type }); res.end(await readFile(join(publicRoot, name)));
    } catch (error) {
      // Never print request bodies, SDK stack traces, or provider URLs to the console.
      send(400, { error: String(error.message || 'Request failed.').replace(/https?:\/\/\S+/g, '[provider]').slice(0, 300) });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return server;
}
