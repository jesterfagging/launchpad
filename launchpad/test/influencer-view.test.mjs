// AI influencer (v71.30) where visitors and creators see it: the Influencer card in the coin page's agent section (the
// public view, the post feed with media, the creator's controls and the X reconnect flow), the directory card's portrait
// and "on X" badge, and the owner panel's flag, row pill and "Pause posting" control. Nothing that looks like a file
// path, a token or a request id is ever rendered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createAgentView } from '../public/agent-view.mjs';
import { createAgentsPage } from '../public/agents.js';
import { createAdminAgents } from '../public/admin-agents-ui.mjs';
import { influencerView, createInfluencerBadge, safeXUrl, safeMediaUrl, validXMessage, xAccountView } from '../public/influencer-ui.mjs';
import { INFLUENCER_RULES } from '../public/influencer-catalog.mjs';

const MINT = '8db6sLzSneci4TbNPiwyNZrVYh7T879SxRRsHpS2PgiE', NOW = 1_760_000_000_000, AGENT = '1234567890abcdef12345678', POST1 = 'abcdefabcdefabcdefabcdef', POST2 = 'fedcbafedcbafedcbafedcba', POST3 = '0123456789abcdef01234567', X1 = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const LEAKS = { masterFile: '/var/lib/launchpad/influencer/' + AGENT + '/master.png', referenceFile: '/var/lib/launchpad/influencer/uploads/ref.png', accessToken: 'ya29.secret-token-value-zzz', refreshToken: 'rt-secret-refresh', requestId: 'hf_req_9f8e7d6c', soulId: 'soul-1234', providerError: 'Maximum number of concurrent requests (4) has been reached' };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const ok = value => ({ ok: true, status: 200, json: async () => value });
const text = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
const view = (over = {}) => ({ enabled: true, character: true, postToX: true, state: 'ready', stateLabel: 'Ready', stateReason: '', handle: 'moonfox', xUrl: 'https://x.com/moonfox', avatarUrl: '/influencer-media/' + AGENT + '/master.png', sheetUrl: '/influencer-media/' + AGENT + '/sheet.png', tiles: { kind: 'person', presentsAs: 'woman', age: '30s', build: 'athletic', skin: 'medium', hair: 'curly', outfit: 'techwear', style: 'cinematic', palette: 'neon', setting: 'city', vibe: 'confident' }, source: 'tiles', media: 'images', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 0 }, cadenceHours: 6, coinLink: true, today: { posts: 1, images: 0, videos: 0 }, nextPostAt: NOW + 2 * 3_600_000, postingPaused: false, adminPaused: false, regenerationsLeft: 2, ...LEAKS,
  posts: [{ id: POST1, kind: 'image', text: 'Scouting the pool today. Volume is steady. #SCOUT', state: 'posted', stateLabel: 'Posted', url: 'https://x.com/moonfox/status/1234567890', mediaUrl: '/influencer-media/' + AGENT + '/' + POST1 + '.png', at: NOW - 3_600_000, postedAt: NOW - 3_500_000, ...LEAKS }, { id: POST2, kind: 'video', text: 'A short clip from the trading floor.', state: 'generating', stateLabel: 'Generating media', url: '', mediaUrl: '', at: NOW - 600_000, postedAt: null }, { id: POST3, kind: 'text', text: 'Plain words only.', state: 'failed', stateLabel: 'Failed', url: 'javascript:alert(1)', mediaUrl: 'https://evil.example/' + AGENT + '/x.png', at: NOW - 7_200_000, postedAt: null, error: 'expired' }], rules: INFLUENCER_RULES, ...over });
const detail = (over = {}) => ({ id: 'agent-1', mint: MINT, name: 'Scout Signal', symbol: 'SCOUT', image: null, route: 'raydium', href: '/coin?mint=' + MINT + '#agent', state: 'ready', stateLabel: 'Ready', stateReason: '', mission: 'Keep a steady rhythm.', model: 'openai/gpt-6-luna', capabilities: ['research', 'browser'], personalityPreset: 'analyst', personality: '', createdAt: NOW - 86_400_000, activatedAt: NOW - 80_000_000, revision: 2, nextRunAt: NOW + 240_000, objective: 'custom', objectiveName: 'Custom', objectiveSummary: '', objectiveSettings: {}, program: null, blockers: [], launchState: 'live', domains: [], approvedDomains: [], wallet: '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc', policyHash: 'a'.repeat(64), policyVersion: 'agent-policy-v2', custody: 'Operator-managed wallet.', creatorPaused: false, adminPaused: false, integrityPaused: false, pauseReason: '', balances: { sol: {}, usd: {}, usdc: {} }, fees: { total: '0', count: 0 }, lastRun: null, todayBudget: {}, policy: {}, funding: 'Raydium agent launches keep the standard 0.50% creator trading fee.', influencer: view(), ...over });
const creator = { authenticated: true, token: 'csrf', account: { id: 'acct', username: 'mira_builds' } };
const mine = () => ({ agents: [{ id: 'agent-1', mint: MINT, mission: 'Keep a steady rhythm.', personalityPreset: 'analyst', personality: '', domains: [], model: 'openai/gpt-6-luna', creatorPaused: false, revision: 2, state: 'ready', models: ['openai/gpt-6-luna'], approvedDomains: [], objective: 'custom', objectiveSettings: {}, capabilities: ['research', 'browser'] }] });
const noLeaks = (markup, label) => { for (const [key, value] of Object.entries(LEAKS)) assert.equal(markup.includes(value), false, label + ' renders ' + key); assert.equal(markup.includes('/var/lib'), false, label + ' renders a file path'); };

async function page(t, { agent = detail(), session = null, me = null, influencerRoute = null, control = null, href = 'https://launchpad.test/coin?mint=' + MINT + '#agent' } = {}) {
  const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  const posts = [], calls = [], opened = [], accounts = [];
  Object.defineProperty(window, 'location', { value: { href, origin: 'https://launchpad.test', pathname: '/coin', search: '?mint=' + MINT, hash: new URL(href).hash }, configurable: true });
  Object.defineProperty(window, 'open', { value: (url, name, features) => { opened.push({ url, name, features }); return { closed: false, close() {} }; }, configurable: true });
  Object.defineProperty(window, 'confirm', { value: () => true, configurable: true });
  const fetcher = async (path, options = {}) => {
    calls.push({ path, options }); const url = new URL(path, 'https://launchpad.test');
    if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push({ path: url.pathname, body, token: options.headers['x-control-token'] }); if (url.pathname === '/api/launchpad/agents/influencer') return ok({ influencer: control ? control(body) : { ...agent.influencer, ...body } }); return ok({ ...me.agents[0], ...body, revision: 3 }); }
    if (url.pathname === '/api/launchpad/agents/agent') return ok(agent);
    if (url.pathname === '/api/launchpad/agents/me') return ok(me || { agents: [] });
    if (url.pathname === '/api/launchpad/agents/activity') return ok({ events: [], nextBefore: null });
    if (url.pathname === '/api/launchpad/agents/influencer') { const data = influencerRoute?.(url); return data ? ok(data) : { ok: false, status: 404, json: async () => ({ error: 'Not found' }) }; }
    if (url.pathname === '/api/launchpad/x/connect') return ok({ url: 'https://x.com/i/oauth2/authorize?state=s2&code_challenge=c2', expiresAt: NOW + 600_000 });
    if (url.pathname === '/api/launchpad/x/accounts') return ok({ accounts: accounts.slice(), available: true });
    return { ok: false, status: 404, json: async () => ({ error: 'Not found: ' + path }) };
  };
  const root = document.getElementById('root');
  const app = createAgentView({ document, window: Object.assign(window, { matchMedia: () => ({ matches: true }), setTimeout, clearTimeout }), root, mint: MINT, fetcher, clock: () => NOW, setTimer: () => 1, clearTimer: () => {} });
  t.after(() => app.destroy());
  if (session) app.setSession(session);
  await app.refresh(); await flush();
  return { document, window, root, app, posts, calls, opened, accounts, $: selector => root.querySelector(selector), $$: selector => [...root.querySelectorAll(selector)], text: selector => text(root.querySelector(selector)), card: () => root.querySelector('.influencer-card'), message(data, origin = 'https://launchpad.test') { window.dispatchEvent(new window.MessageEvent('message', { data, origin })); } };
}

test('the public Influencer card: portrait and state, the handle linking to X, what the character is, cadence and today’s counters, the post feed with a picture, a clip in progress and a failed post, the rules; nothing private leaks', async t => {
  const ui = await page(t);
  const card = ui.card(); assert(card, 'the card is in the overview'); assert.equal(card.hidden, false); assert.equal(card.getAttribute('aria-label'), 'AI influencer');
  assert.equal(card.querySelector('.influencer-avatar img').getAttribute('src'), '/influencer-media/' + AGENT + '/master.png'); assert.equal(card.querySelector('.influencer-avatar').dataset.state, 'ready');
  assert.equal(text(card.querySelector('.influencer-pill')), 'Ready'); assert.equal(card.querySelector('.influencer-pill').dataset.state, 'ready');
  const handle = card.querySelector('.influencer-handle'); assert.equal(handle.hidden, false); assert.equal(text(handle), '@moonfox ↗'); assert.equal(handle.getAttribute('href'), 'https://x.com/moonfox'); assert.equal(handle.rel, 'noopener noreferrer');
  assert.match(text(card.querySelector('.influencer-reason')), /Next post in 2\.0 h at the earliest/);
  const facts = Object.fromEntries([...card.querySelectorAll('.influencer-facts > div')].map(row => [text(row.querySelector('dt')), text(row.querySelector('dd'))]));
  assert.equal(facts.Character, 'Woman · Thirties · Curly · Techwear · Cinematic'); assert.equal(facts.Media, 'Pictures'); assert.equal(facts['Posts to'], '@moonfox'); assert.equal(facts.Cadence, 'Every 6 hours · coin link added'); assert.equal(facts.Today, 'posts 1/4 · pictures 0/2'); assert.equal(facts['Next post'], 'in 2.0 h');
  assert.equal(card.querySelector('.influencer-facts a').getAttribute('href'), '/influencer-media/' + AGENT + '/sheet.png');
  const rows = [...card.querySelectorAll('.influencer-post')]; assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => [row.dataset.kind, row.dataset.state, text(row.querySelector('.influencer-post-pill'))]), [['image', 'posted', 'Posted'], ['video', 'generating', 'Generating media'], ['text', 'failed', 'Failed']]);
  assert.equal(text(rows[0].querySelector('.influencer-post-text')), 'Scouting the pool today. Volume is steady. #SCOUT');
  assert.equal(rows[0].querySelector('.influencer-media img').getAttribute('src'), '/influencer-media/' + AGENT + '/' + POST1 + '.png'); assert.equal(rows[0].querySelector('.influencer-media img').getAttribute('loading'), 'lazy');
  const link = rows[0].querySelector('.agent-event-links a'); assert.equal(text(link), 'View on X ↗'); assert.equal(link.getAttribute('href'), 'https://x.com/moonfox/status/1234567890'); assert.equal(link.target, '_blank');
  assert.equal(rows[1].querySelector('.influencer-media'), null, 'no media while it is still generating'); assert.equal(rows[1].querySelector('a'), null);
  assert.equal(rows[2].querySelector('a'), null, 'a javascript: url is never a link'); assert.equal(rows[2].querySelector('.influencer-media'), null, 'a media url off this host is never rendered'); assert.match(text(rows[2]), /expired/);
  assert.deepEqual([...card.querySelectorAll('.influencer-rules li')].map(text), [...INFLUENCER_RULES]);
  assert.equal(card.querySelector('.influencer-controls').hidden, true, 'no controls for a visitor'); assert.equal(card.querySelector('.influencer-form'), null);
  noLeaks(card.innerHTML, 'the card'); noLeaks(ui.root.innerHTML, 'the agent section');
});

test('a clip renders as a video element that does not preload; a character without X, a paused or generating influencer and a revoked account read as such', async t => {
  const clip = await page(t, { agent: detail({ influencer: view({ media: 'video', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 1 }, today: { posts: 2, images: 1, videos: 1 }, posts: [{ id: POST2, kind: 'video', text: 'Clip.', state: 'posted', stateLabel: 'Posted', url: 'https://x.com/moonfox/status/2', mediaUrl: '/influencer-media/' + AGENT + '/' + POST2 + '.mp4', at: NOW - 1000, postedAt: NOW - 900 }] }) }) });
  const video = clip.card().querySelector('.influencer-media video'); assert(video, 'a video element'); assert.equal(video.getAttribute('src'), '/influencer-media/' + AGENT + '/' + POST2 + '.mp4'); assert.equal(video.getAttribute('preload'), 'none'); assert.equal(video.hasAttribute('controls'), true); assert.equal(video.getAttribute('poster'), '/influencer-media/' + AGENT + '/master.png');
  assert.equal(clip.text('.influencer-facts'), clip.text('.influencer-facts')); assert.match(clip.text('.influencer-facts'), /posts 2\/4 · pictures 1\/2 · clips 1\/1/);
  const quiet = await page(t, { agent: detail({ influencer: view({ postToX: false, handle: null, xUrl: null, posts: [], nextPostAt: null }) }) });
  assert.equal(quiet.card().querySelector('.influencer-handle').hidden, true); assert.match(quiet.text('.influencer-facts'), /Posts to\s*Nowhere \(character only\)/); assert.doesNotMatch(quiet.text('.influencer-facts'), /Cadence/); assert.match(quiet.text('.influencer-posts'), /does not post to X/);
  const paused = await page(t, { agent: detail({ influencer: view({ state: 'paused', stateLabel: 'Posting paused', stateReason: 'X revoked the connection. Reconnect the account from the coin page.', handle: null, xUrl: null }) }) });
  assert.equal(text(paused.card().querySelector('.influencer-pill')), 'Posting paused'); assert.equal(paused.card().querySelector('.influencer-pill').dataset.state, 'paused'); assert.match(paused.text('.influencer-reason'), /X revoked the connection/); assert.match(paused.text('.influencer-facts'), /X \(no account attached\)/);
  const generating = await page(t, { agent: detail({ influencer: view({ state: 'generating', stateLabel: 'Creating the character', avatarUrl: null, sheetUrl: null, posts: [] }) }) });
  assert.equal(generating.card().querySelector('.influencer-avatar img'), null); assert.equal(text(generating.card().querySelector('.influencer-avatar span')), 'AI'); assert.match(generating.text('.influencer-reason'), /master portrait is being created/); assert.match(generating.text('.influencer-posts'), /No posts yet/);
  // A bad handle, a bad avatar path or a bad profile url render nothing of theirs.
  const odd = await page(t, { agent: detail({ influencer: view({ handle: '<script>alert(1)</script>', xUrl: 'https://evil.example/moonfox', avatarUrl: 'https://evil.example/master.png', sheetUrl: '../../etc/passwd' }) }) });
  assert.equal(odd.card().querySelector('.influencer-handle').hidden, true); assert.equal(odd.card().querySelector('.influencer-avatar img'), null); assert.equal(odd.card().querySelector('.influencer-facts a'), null); assert.equal(odd.root.innerHTML.includes('evil.example'), false);
});

test('no card without an influencer; a detail that does not carry the field asks GET /influencer?mint= and stays quiet when the host has none', async t => {
  const none = await page(t, { agent: detail({ influencer: null }) });
  assert.equal(none.card(), null); assert.equal(none.calls.some(call => call.path.startsWith('/api/launchpad/agents/influencer')), false);
  const legacy = await page(t, { agent: detail({ influencer: undefined }) });
  assert.equal(legacy.calls.some(call => call.path === '/api/launchpad/agents/influencer?mint=' + MINT), true, 'the endpoint is asked');
  assert.equal(legacy.card()?.hidden ?? true, true, 'a 404 leaves the card hidden'); assert.equal(legacy.text('[data-agent-message]'), '', 'and says nothing');
  const served = await page(t, { agent: detail({ influencer: undefined }), influencerRoute: () => ({ influencer: view({ handle: 'nightowl', xUrl: 'https://x.com/nightowl' }), at: NOW }) });
  assert.equal(served.card().hidden, false); assert.equal(text(served.card().querySelector('.influencer-handle')), '@nightowl ↗');
});

// What the server does with a control body, as far as the card can see it: the view with the change applied.
const applyControl = (current, body) => ({ ...current, ...(typeof body.pausePosting === 'boolean' ? { postingPaused: body.pausePosting, state: body.pausePosting ? 'paused' : 'ready', stateLabel: body.pausePosting ? 'Posting paused' : 'Ready', stateReason: body.pausePosting ? 'Paused by the creator.' : '' } : {}), ...(body.cadenceHours ? { cadenceHours: body.cadenceHours, coinLink: body.coinLink, caps: { dailyPosts: body.dailyPosts, dailyImages: body.dailyImages, dailyVideos: body.dailyVideos }, media: body.media } : {}), ...(body.regenerate ? { state: 'generating', stateLabel: 'Creating the character', regenerationsLeft: 1 } : {}), ...(body.xAccountId ? { handle: 'nightowl', xUrl: 'https://x.com/nightowl', state: 'ready' } : {}), ...(body.detachX ? { handle: null, xUrl: null, state: 'paused', stateLabel: 'Posting paused', stateReason: 'No X account attached.' } : {}) });
test('creator controls: save posts the caps, cadence, media and link choice; pause and resume, regenerate (with the count), detach, and reconnect through the popup that attaches the account it returns', async t => {
  let current = view(); const ui = await page(t, { session: creator, me: mine(), control: body => { current = applyControl(current, body); return current; } });
  const controls = ui.card().querySelector('.influencer-controls'); assert.equal(controls.hidden, false);
  const button = action => ui.card().querySelector('[data-influencer-action="' + action + '"]');
  assert.equal(text(button('pause')), 'Pause posting'); assert.equal(text(button('regenerate')), 'Regenerate character (2 left)'); assert.equal(text(button('connect')), 'Reconnect X'); assert.equal(text(button('detach')), 'Detach X account');
  const form = ui.card().querySelector('.influencer-form');
  assert.equal(form.querySelector('[name=cadenceHours]').value, '6'); assert.equal(form.querySelector('[name=dailyPosts]').value, '4'); assert.equal(form.querySelector('[name=coinLink]').checked, true); assert.equal(form.querySelector('[name=media]').value, 'images'); assert.equal(form.querySelector('[name=dailyImages]').value, '2'); assert.equal(form.querySelector('[name=dailyVideos]').closest('label').hidden, true);
  form.querySelector('[name=cadenceHours]').value = '12'; form.querySelector('[name=dailyPosts]').value = '6'; form.querySelector('[name=coinLink]').checked = false; form.querySelector('[name=media]').value = 'video'; form.querySelector('[name=media]').onchange(); assert.equal(form.querySelector('[name=dailyVideos]').closest('label').hidden, false); form.querySelector('[name=dailyVideos]').value = '1';
  button('save').onclick(); await flush();
  assert.deepEqual(ui.posts.at(-1), { path: '/api/launchpad/agents/influencer', body: { mint: MINT, cadenceHours: 12, dailyPosts: 6, coinLink: false, media: 'video', dailyImages: 2, dailyVideos: 1 }, token: 'csrf' });
  assert.match(ui.text('.influencer-status'), /Settings saved/); assert.match(ui.text('.influencer-facts'), /Every 12 hours/); assert.equal(ui.text('.influencer-facts').includes('coin link added'), false); assert.match(ui.text('.influencer-facts'), /Pictures and clips/);
  button('pause').onclick(); await flush();
  assert.deepEqual(ui.posts.at(-1).body, { mint: MINT, pausePosting: true }); assert.equal(text(button('pause')), 'Resume posting'); assert.match(ui.text('.influencer-status'), /Posting paused/);
  button('pause').onclick(); await flush(); assert.deepEqual(ui.posts.at(-1).body, { mint: MINT, pausePosting: false }); assert.equal(text(button('pause')), 'Pause posting');
  button('regenerate').onclick(); await flush(); assert.deepEqual(ui.posts.at(-1).body, { mint: MINT, regenerate: true }); assert.match(ui.text('.influencer-status'), /new character is being created/);
  // Reconnect: GET /connect with returnTo=coin:<mint>, the popup, then the popup's message attaches the account.
  button('connect').onclick(); await flush();
  assert.equal(ui.calls.some(call => call.path === '/api/launchpad/x/connect?returnTo=' + encodeURIComponent('coin:' + MINT)), true); assert.equal(ui.opened.length, 1); assert.equal(ui.opened[0].name, 'curve-x'); assert.equal(ui.opened[0].url, 'https://x.com/i/oauth2/authorize?state=s2&code_challenge=c2');
  ui.accounts.push({ id: X1, handle: 'nightowl', displayName: 'Night Owl', state: 'connected', stateReason: '', agentMint: null, connectedAt: NOW, lastPostAt: 0, postsToday: 0 });
  ui.message({ type: 'curve-x-connected', id: X1 }, 'https://evil.example'); await flush(); assert.equal(ui.posts.some(post => post.body.xAccountId), false, 'another origin is ignored');
  ui.message({ type: 'curve-x-connected', id: X1 }); await flush(); await flush();
  assert.deepEqual(ui.posts.at(-1).body, { mint: MINT, xAccountId: X1 }); assert.match(ui.text('.influencer-status'), /X account attached/);
  button('detach').onclick(); await flush(); assert.deepEqual(ui.posts.at(-1).body, { mint: MINT, detachX: true });
  // The agent's own message line was never used for influencer news.
  assert.equal(ui.text('[data-agent-message]'), '');
  // No regenerate while generating or out of tries; no X buttons for a character-only influencer; the failed-POST message reads as text.
  const limited = await page(t, { session: creator, me: mine(), agent: detail({ influencer: view({ regenerationsLeft: 0 }) }) }); assert.equal(limited.card().querySelector('[data-influencer-action="regenerate"]'), null);
  const busy = await page(t, { session: creator, me: mine(), agent: detail({ influencer: view({ state: 'generating' }) }) }); assert.equal(busy.card().querySelector('[data-influencer-action="regenerate"]'), null);
  const unknown = await page(t, { session: creator, me: mine(), agent: detail({ influencer: view({ regenerationsLeft: undefined }) }) }); assert.equal(text(unknown.card().querySelector('[data-influencer-action="regenerate"]')), 'Regenerate character');
  const quiet = await page(t, { session: creator, me: mine(), agent: detail({ influencer: view({ postToX: false, handle: null }) }) }); assert.equal(quiet.card().querySelector('[data-influencer-action="connect"]'), null); assert.equal(quiet.card().querySelector('[data-influencer-action="pause"]'), null); assert(quiet.card().querySelector('[data-influencer-action="save"]'));
  // The callback hash on the coin page (no opener): the account it names is attached once the creator's controls are known.
  const landed = await page(t, { session: creator, me: mine(), href: 'https://launchpad.test/coin?mint=' + MINT + '#agent&x-connected=' + X1, control: body => applyControl(view(), body) });
  assert.deepEqual(landed.posts.find(post => post.body.xAccountId)?.body, { mint: MINT, xAccountId: X1 });
});

test('daily feature clip (v71.32): the card shows the chosen length, its price and today’s use, feature posts are marked with their seconds, the creator picks Off or a length the host offers and the choice travels with the settings; the server’s pause flags are read', async t => {
  const featureClip = { seconds: 15, usedToday: false, available: true, lengths: [10, 15], costsUsd: { 10: '1310000', 15: '1910000', 30: '3760000' } };
  const posts = [{ id: POST2, kind: 'video', text: 'Thirty seconds from the floor.', state: 'posted', stateLabel: 'Posted', url: 'https://x.com/moonfox/status/3', mediaUrl: '/influencer-media/' + AGENT + '/' + POST2 + '.mp4', at: NOW - 1000, postedAt: NOW - 900, seconds: 15, feature: true }, { id: POST1, kind: 'video', text: 'A quick one.', state: 'posted', stateLabel: 'Posted', url: 'https://x.com/moonfox/status/4', mediaUrl: '/influencer-media/' + AGENT + '/' + POST1 + '.mp4', at: NOW - 5000, postedAt: NOW - 4000, seconds: 5, feature: false }];
  const current = view({ media: 'video', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 1 }, today: { posts: 2, images: 1, videos: 1, feature: 0 }, featureClip, posts, postingPaused: undefined, adminPaused: undefined, pausedByCreator: false, pausedByPlatform: false });
  const ui = await page(t, { agent: detail({ influencer: current }) });
  const facts = Object.fromEntries([...ui.card().querySelectorAll('.influencer-facts > div')].map(row => [text(row.querySelector('dt')), text(row.querySelector('dd'))]));
  assert.equal(facts['Feature clip'], '15 seconds, once a day ($1.91) · available today'); assert.equal(facts.Today, 'posts 2/4 · pictures 1/2 · clips 1/1 · feature clip 0/1');
  const rows = [...ui.card().querySelectorAll('.influencer-post')];
  assert.equal(rows[0].dataset.feature, 'true'); assert.equal(text(rows[0].querySelector('.influencer-post-kind')), 'Feature clip · 15 s'); assert.equal(rows[1].dataset.feature, undefined); assert.equal(text(rows[1].querySelector('.influencer-post-kind')), 'Clip'); assert.equal(rows[1].querySelector('.influencer-post-kind').title, '5-second clip');
  const used = await page(t, { agent: detail({ influencer: view({ media: 'video', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 1 }, today: { posts: 2, images: 1, videos: 1, feature: 1 }, featureClip: { ...featureClip, usedToday: true, available: false }, posts: [] }) }) });
  assert.match(used.text('.influencer-facts'), /Feature clip\s*15 seconds, once a day \(\$1\.91\) · used today/); assert.match(used.text('.influencer-facts'), /feature clip 1\/1/);
  const off = await page(t, { agent: detail({ influencer: view({ media: 'video', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 1 }, featureClip: { ...featureClip, seconds: 0, available: false }, posts: [] }) }) });
  assert.doesNotMatch(off.text('.influencer-facts'), /Feature clip|feature clip/, 'off: no row, no counter');
  const gone = await page(t, { agent: detail({ influencer: view({ media: 'video', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 1 }, featureClip: { ...featureClip, seconds: 30, available: false }, posts: [] }) }) });
  assert.match(gone.text('.influencer-facts'), /30 seconds, once a day \(\$3\.76\) · not available on this host right now/);
  // The creator's controls: Off plus the host's lengths with prices (a chosen length the host no longer offers stays listed, marked), hidden without clips, saved as seconds.
  let state = current; const mine_ = mine(); const creatorUi = await page(t, { session: creator, me: mine_, agent: detail({ influencer: current }), control: body => { state = { ...state, ...(body.media ? { media: body.media, caps: { dailyPosts: body.dailyPosts, dailyImages: body.dailyImages, dailyVideos: body.dailyVideos }, featureClip: { ...state.featureClip, seconds: body.featureClipSeconds } } : {}) }; return state; } });
  const form = creatorUi.card().querySelector('.influencer-form'), select = form.querySelector('[name=featureClipSeconds]');
  assert.equal(select.closest('label').hidden, false); assert.deepEqual([...select.options].map(option => [option.value, text(option), option.title]), [['0', 'Off', ''], ['10', '10 seconds · $1.31', ''], ['15', '15 seconds · $1.91', '']]); assert.equal(select.value, '15');
  assert.match(text(select.closest('label')), /One per UTC day on top of the 5-second clips/);
  form.querySelector('[name=media]').value = 'images'; form.querySelector('[name=media]').onchange(); assert.equal(select.closest('label').hidden, true, 'no clips: no feature clip');
  form.querySelector('[name=media]').value = 'video'; form.querySelector('[name=media]').onchange(); assert.equal(select.closest('label').hidden, false);
  select.value = '10'; creatorUi.card().querySelector('[data-influencer-action="save"]').onclick(); await flush();
  assert.deepEqual(creatorUi.posts.at(-1).body, { mint: MINT, cadenceHours: 6, dailyPosts: 4, coinLink: true, media: 'video', dailyImages: 2, dailyVideos: 1, featureClipSeconds: 10 });
  assert.match(creatorUi.text('.influencer-facts'), /Feature clip\s*10 seconds, once a day \(\$1\.31\)/); assert.equal(creatorUi.card().querySelector('.influencer-form [name=featureClipSeconds]').value, '10');
  // Saving with pictures only sends 0 for the feature clip, as the server would set anyway.
  const form2 = creatorUi.card().querySelector('.influencer-form'); form2.querySelector('[name=media]').value = 'images'; form2.querySelector('[name=media]').onchange(); creatorUi.card().querySelector('[data-influencer-action="save"]').onclick(); await flush();
  assert.deepEqual(creatorUi.posts.at(-1).body, { mint: MINT, cadenceHours: 6, dailyPosts: 4, coinLink: true, media: 'images', dailyImages: 2, dailyVideos: 0, featureClipSeconds: 0 });
  // A chosen 30 s that this host no longer offers stays selectable (marked) so the creator sees it and can switch it off.
  const stale = await page(t, { session: creator, me: mine(), agent: detail({ influencer: view({ media: 'video', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 1 }, featureClip: { ...featureClip, seconds: 30, available: false } }) }) });
  const staleSelect = stale.card().querySelector('[name=featureClipSeconds]'); assert.deepEqual([...staleSelect.options].map(option => [option.value, option.title]), [['0', ''], ['10', ''], ['15', ''], ['30', 'Not available on this host right now.']]); assert.equal(staleSelect.value, '30');
  // A view from before the option (no featureClip): no select, nothing about it in the body.
  const legacy = await page(t, { session: creator, me: mine(), agent: detail({ influencer: view({ media: 'video', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 1 } }) }) });
  assert.equal(legacy.card().querySelector('[name=featureClipSeconds]').closest('label').hidden, true); legacy.card().querySelector('[data-influencer-action="save"]').onclick(); await flush(); assert.equal('featureClipSeconds' in legacy.posts.at(-1).body, false);
  // The server names its pause flags pausedByCreator / pausedByPlatform: a platform pause does not read as the creator's.
  const platform = await page(t, { session: creator, me: mine(), agent: detail({ influencer: view({ state: 'paused', stateLabel: 'Posting paused', stateReason: 'Paused by the platform.', postingPaused: undefined, adminPaused: undefined, pausedByCreator: false, pausedByPlatform: true }) }) });
  assert.equal(text(platform.card().querySelector('[data-influencer-action="pause"]')), 'Pause posting', 'the creator did not pause; the button still offers to');
  const own = await page(t, { session: creator, me: mine(), agent: detail({ influencer: view({ state: 'paused', stateLabel: 'Posting paused', stateReason: 'Paused by the creator.', postingPaused: undefined, adminPaused: undefined, pausedByCreator: true, pausedByPlatform: false }) }) });
  assert.equal(text(own.card().querySelector('[data-influencer-action="pause"]')), 'Resume posting');
  // The pure view: lengths and costs are read defensively; seconds outside the catalogue read as off.
  const cleaned = influencerView(view({ featureClip: { seconds: 7, usedToday: 'yes', available: 1, lengths: ['15', 30, 99], costsUsd: { 15: '1910000', 30: 'x', 99: '1' } }, today: { posts: 0, images: 0, videos: 0, feature: '2' } }));
  assert.deepEqual(cleaned.featureClip, { seconds: 0, usedToday: true, available: false, lengths: [15, 30], costsUsd: { 15: '$1.91' }, known: true }); assert.equal(cleaned.today.feature, 2);
  assert.deepEqual(influencerView(view()).featureClip, { seconds: 0, usedToday: false, available: false, lengths: [], costsUsd: {}, known: false });
  assert.deepEqual(influencerView(view({ posts: [{ id: POST1, kind: 'video', text: 'x', state: 'posted', seconds: 'abc', feature: 'true' }] })).posts[0], { id: POST1, kind: 'video', text: 'x', state: 'posted', stateLabel: 'Posted', url: '', mediaUrl: '', at: null, postedAt: null, error: '', feature: false, seconds: 5 });
});

test('directory cards: the portrait replaces the coin image, "on X" links to the profile, a character without X is marked, anything off this host is ignored', async t => {
  const { document } = parseHTML(await readFile(new URL('../public/agents.html', import.meta.url), 'utf8'));
  const row = (index, influencer) => ({ id: 'agent-' + index, mint: 'Mint' + String(index).padStart(3, '0'), name: 'Agent ' + index, symbol: 'AG' + index, state: 'ready', stateLabel: 'Ready', href: '/coin?mint=Mint' + String(index).padStart(3, '0') + '#agent', mission: 'Research and post updates.', model: 'Model', capabilities: ['research'], treasurySol: '1', operatingBackedUsd: '$1.00', feesSol: '0', feeReceipts: 0, route: 'raydium', lastActivity: null, image: '/token-images/' + 'b'.repeat(64) + '.webp', objective: 'custom', objectiveName: 'Custom', personalityPreset: 'analyst', influencer });
  const rows = [row(1, { avatarUrl: '/influencer-media/' + AGENT + '/master.png', handle: 'moonfox', xUrl: 'https://x.com/moonfox', state: 'ready', stateLabel: 'Ready', character: true, postToX: true }), row(2, { avatarUrl: null, handle: null, xUrl: null, state: 'generating', stateLabel: 'Creating the character', character: true, postToX: false }), row(3, null), row(4, { avatarUrl: 'https://evil.example/master.png', handle: 'bad handle!', xUrl: 'https://evil.example', state: 'paused', stateLabel: 'Posting paused', character: false, postToX: true })];
  const fetcher = async path => { const url = new URL(path, 'https://launchpad.test'); if (path === '/api/session') return ok({ authenticated: false }); if (url.pathname === '/api/launchpad/agents/catalog') return ok({ intakeOpen: true, models: [{ name: 'Model' }], rules: [], funding: {} }); if (url.pathname === '/api/launchpad/agents') return ok({ agents: rows, nextCursor: null, intakeOpen: true, at: NOW }); throw Error('Unexpected request ' + path); };
  const app = createAgentsPage({ document, window: { setTimeout, clearTimeout, matchMedia: () => ({ matches: true }) }, fetcher, clock: () => NOW, setTimer: () => 1, clearTimer: () => {}, shell: () => {} });
  t.after(() => app.destroy()); await app.ready; await flush();
  const cards = [...document.querySelectorAll('#agents-cards .agents-card')]; assert.equal(cards.length, 4);
  const first = cards[0]; assert.equal(first.querySelector('.agent-avatar img').getAttribute('src'), '/influencer-media/' + AGENT + '/master.png'); assert.equal(first.querySelector('.agent-avatar img').dataset.influencer, 'portrait'); assert.equal(first.querySelector('.agent-avatar').classList.contains('has-influencer'), true);
  const badge = first.querySelector('.influencer-badge'); assert.equal(badge.tagName, 'A'); assert.equal(text(badge), 'on X'); assert.equal(badge.getAttribute('href'), 'https://x.com/moonfox'); assert.equal(badge.rel, 'noopener noreferrer'); assert.equal(badge.title, '@moonfox · Ready'); assert.equal(badge.dataset.state, 'ready');
  assert.deepEqual([...first.querySelectorAll('.agents-card-chips .agent-pill')].map(text), ['Custom', 'Analyst'], 'the chips row is untouched');
  const second = cards[1]; assert.equal(second.querySelector('.agent-avatar img').getAttribute('src'), '/token-images/' + 'b'.repeat(64) + '.webp', 'no portrait yet: the coin image'); assert.equal(second.querySelector('.influencer-badge').tagName, 'SPAN'); assert.equal(text(second.querySelector('.influencer-badge')), 'AI character'); assert.equal(second.querySelector('.influencer-badge').title, 'AI character · Creating the character');
  assert.equal(cards[2].querySelector('.influencer-badge'), null); assert.equal(cards[2].querySelector('.agent-avatar').classList.contains('has-influencer'), false);
  const fourth = cards[3]; assert.equal(fourth.querySelector('.agent-avatar img').getAttribute('src'), '/token-images/' + 'b'.repeat(64) + '.webp', 'an avatar url off this host is ignored'); assert.equal(fourth.querySelector('.influencer-badge'), null, 'no badge without a valid handle or a character');
  assert.equal(document.body.innerHTML.includes('evil.example'), false);
  // The pure helpers behind it.
  assert.equal(createInfluencerBadge(document, null), null); assert.equal(createInfluencerBadge(document, { handle: 'x'.repeat(16), character: false }), null);
  assert.equal(safeXUrl('https://twitter.com/moonfox/status/1'), 'https://twitter.com/moonfox/status/1'); assert.equal(safeXUrl('http://x.com/moonfox', 'moonfox'), 'https://x.com/moonfox'); assert.equal(safeXUrl('https://x.com.evil.example/a', ''), '');
  assert.equal(safeMediaUrl('/influencer-media/' + AGENT + '/master.png'), '/influencer-media/' + AGENT + '/master.png'); assert.equal(safeMediaUrl('/influencer-media/' + AGENT + '/../x.png'), ''); assert.equal(safeMediaUrl('/influencer-media/' + AGENT + '/' + POST1 + '.mp4'), '/influencer-media/' + AGENT + '/' + POST1 + '.mp4'); assert.equal(safeMediaUrl('/influencer-media/' + AGENT + '/reference.png'), '');
  assert.deepEqual(validXMessage({ origin: 'https://launchpad.test', data: { type: 'curve-x-connected', id: X1 } }, 'https://launchpad.test'), { connected: X1 }); assert.equal(validXMessage({ origin: 'https://launchpad.test', data: { type: 'curve-x-connected', id: X1 } }, ''), null); assert.equal(validXMessage({ origin: 'https://launchpad.test', data: { type: 'other' } }, 'https://launchpad.test'), null);
  assert.equal(xAccountView({ id: 'short', handle: 'moonfox' }), null); assert.equal(xAccountView({ id: X1, handle: 'moonfox', accessToken: 'secret' }).accessToken, undefined, 'nothing beyond the listed fields survives');
  const cleaned = influencerView(view()); assert.equal('masterFile' in cleaned, false); assert.equal('accessToken' in cleaned, false); assert.equal(cleaned.posts[0].requestId, undefined); assert.equal(influencerView(null), null); assert.equal(influencerView('x'), null);
});

test('the owner panel: the AI influencer flag, the row pill, the influencer block of an opened row with its stats and the Pause posting control; rows without the field are unchanged', async () => {
  const OWNER = { id: 'owner', role: 'admin', mfaEnabled: true }, WALLET = 'HTYV4yu546BS3zmNguDwHuY7jGYD2eZNjTBrgLNZSGo6';
  const balances = { treasury: { availableSol: '1.0000', reservedSol: '0.0000', frozenRewardsSol: '0.0000' }, operating: { unsettledSol: '0.0000', settlingSol: '0.0000', settledUsdc: '0.00', backedUsd: '$0.00', reservedUsd: '$0.00', spentUsd: '$0.00', disputedUsd: '$0.00' } };
  const agentRow = (id, symbol, over = {}) => ({ id, mint: MINT, name: symbol + ' agent', symbol, route: 'raydium', launchState: 'live', state: 'ready', stateLabel: 'Ready', stateReason: '', model: 'openai/gpt-6-luna', personalityPreset: 'analyst', wallet: WALLET, domains: [], approvedDomains: [], balances, reimbursableUsdc: '0.00', openActions: 0, activeRun: false, archived: false, hidden: false, creatorPaused: false, adminPaused: false, integrityPaused: false, createdAt: NOW - 86_400_000, nextRunAt: NOW + 240_000, objective: 'custom', objectiveName: 'Custom', program: null, ...over });
  const agents = [agentRow('a-fox', 'FOX', { influencer: view(), influencerStats: { posts24h: 3, media24h: 2, failures24h: 1 } }), agentRow('a-plain', 'PLAIN'), agentRow('a-paused', 'PSD', { influencer: view({ state: 'paused', stateLabel: 'Posting paused', adminPaused: true, stateReason: 'Paused by the platform.' }) }), agentRow('a-feat', 'FEAT', { influencer: view({ media: 'video', caps: { dailyPosts: 4, dailyImages: 2, dailyVideos: 1 }, today: { posts: 1, images: 1, videos: 0, feature: 1 }, featureClip: { seconds: 30, usedToday: true, available: false, lengths: [10, 15, 30], costsUsd: { 10: '1310000', 15: '1910000', 30: '3760000' } } }) })];
  const snapshot = { version: 1, at: NOW, flags: { influencer: false }, effective: { master: true, influencerOpen: false, xConfigured: true, mediaConfigured: false }, worker: { ready: true }, registry: { refreshedAt: NOW }, solvency: { ledgerOk: true, totals: {}, platform: {} }, alerts: [], pending: {}, providerBatches: [], agents, audit: [] };
  const { document } = parseHTML('<html><body></body></html>'); Object.defineProperty(document, 'hidden', { value: false, writable: true });
  const calls = [], auths = [];
  const ui = createAdminAgents({ document, getAccount: () => OWNER, isActive: () => true, clock: () => NOW, message: () => {}, security: { authorize: async label => { auths.push(label); return { password: 'pw', code: '123456' }; } }, api: async (path, body) => { calls.push({ path, body }); return snapshot; }, setTimer: () => 1, clearTimer() {} });
  document.body.append(ui.element); await ui.load();
  const flagButton = [...ui.element.querySelectorAll('#admin-agents-flags button')].find(node => node.textContent === 'Enable ai influencer'); assert(flagButton, 'the flag button'); assert.match(flagButton.title, /X account and a generated character/);
  assert.match(document.getElementById('admin-agents-status').textContent, /influencer off \(X configured, media not configured\)/);
  document.getElementById('admin-agents-reason').value = 'Open the option after the X app review'; flagButton.onclick(); await flush();
  assert.deepEqual(calls.find(call => call.path === '/api/admin/agents/control' && call.body?.flags)?.body, { flags: { influencer: true }, reason: 'Open the option after the X app review', password: 'pw', code: '123456' });
  const row = id => ui.element.querySelector(`[data-agent-row="${id}"]`);
  const pill = row('a-fox').querySelector('.admin-agent-influencer-pill'); assert.equal(text(pill), 'Influencer · ready'); assert.match(pill.title, /Posts to @moonfox/); assert.match(pill.title, /Woman · Thirties/);
  assert.equal(row('a-plain').querySelector('.admin-agent-influencer-pill'), null); assert.equal(row('a-plain').querySelector('.admin-agent-influencer'), null);
  assert.deepEqual([...row('a-plain').querySelectorAll('.admin-gotchi-flags button')].map(text), ['Platform pause', 'Hide (moderation)'], 'a row without the field keeps its controls');
  assert.deepEqual([...row('a-fox').querySelectorAll('.admin-gotchi-flags button')].map(text), ['Platform pause', 'Hide (moderation)', 'Pause posting']);
  const block = row('a-fox').querySelector('.admin-agent-influencer'); assert(block); assert.equal(text(block.querySelector('h4')), 'AI influencer');
  const stats = Object.fromEntries([...block.querySelectorAll('.admin-stat')].map(item => [text(item.querySelector('span')), text(item.querySelector('strong'))]));
  assert.equal(stats['Posts to X'], '@moonfox'); assert.equal(block.querySelector('.admin-stat a').getAttribute('href'), 'https://x.com/moonfox'); assert.equal(stats.Character, 'Woman · Thirties · Curly · Techwear · Cinematic'); assert.equal(stats.Media, 'Pictures'); assert.equal(stats['Caps per day'], '4 posts · 2 pictures · 0 clips'); assert.equal(stats.Today, 'posts 1 · pictures 0 · clips 0'); assert.equal(stats.Cadence, 'every 6 h, coin link added'); assert.equal(stats['Last 24 h'], '3 posts · 2 media jobs · 1 failure');
  const featStats = Object.fromEntries([...row('a-feat').querySelectorAll('.admin-agent-influencer .admin-stat')].map(item => [text(item.querySelector('span')), text(item.querySelector('strong'))]));
  assert.equal(featStats['Caps per day'], '4 posts · 2 pictures · 1 clips · 1 feature clip (30 s)'); assert.equal(featStats.Today, 'posts 1 · pictures 1 · clips 0 · feature clip 1');
  assert.equal(block.querySelectorAll('.admin-agent-posts li').length, 3); assert.match(text(block.querySelectorAll('.admin-agent-posts li')[0]), /Picture · Scouting the pool today/); assert.equal(block.querySelector('.admin-agent-posts a').getAttribute('href'), 'https://x.com/moonfox/status/1234567890');
  noLeaks(block.innerHTML, 'the admin block'); noLeaks(ui.element.innerHTML, 'the admin panel');
  document.getElementById('admin-agents-reason').value = 'Posts repeat a price claim'; [...row('a-fox').querySelectorAll('.admin-gotchi-flags button')].find(node => node.textContent === 'Pause posting').onclick(); await flush();
  const controlCalls = () => calls.filter(call => call.path === '/api/admin/agents/control');
  assert.deepEqual(controlCalls().at(-1), { path: '/api/admin/agents/control', body: { agentId: 'a-fox', influencerPaused: true, reason: 'Posts repeat a price claim', password: 'pw', code: '123456' } });
  const paused = row('a-paused'); assert.equal(text(paused.querySelector('.admin-agent-influencer-pill')), 'Influencer · posting paused'); assert.deepEqual([...paused.querySelectorAll('.admin-gotchi-flags button')].map(text), ['Platform pause', 'Hide (moderation)', 'Resume posting']); assert.match(text(paused.querySelector('.admin-agent-influencer')), /Platform pause on posting/);
  [...paused.querySelectorAll('.admin-gotchi-flags button')].find(node => node.textContent === 'Resume posting').onclick(); await flush();
  assert.deepEqual(controlCalls().at(-1).body, { agentId: 'a-paused', influencerPaused: false, reason: 'Posts repeat a price claim', password: 'pw', code: '123456' });
  ui.destroy();
});
