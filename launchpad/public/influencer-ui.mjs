// AI influencer (Launchpad v71.30): everything the creator and the visitor see of the option. The launch step
// (createInfluencerStep) renders inside the AI Agent settings from the shared catalogue and the agent catalog's
// `influencer` availability; its inputs are all named `influencer*` and read by influencerSettings(), which the
// launch page folds into `agent.influencer`. The X connection (createXConnect) opens the server's authorize URL
// in a popup; the popup lands back on this site with `#x-connected=<id>` or `#x-error=…`, posts that to the
// opener (same origin only) and closes. The coin page card (createInfluencerCard) renders the server's public
// view with the creator's controls, the directory badge (createInfluencerBadge) marks agents that post to X.
// Nothing here is trusted beyond its shape: urls, handles and ids are checked before they are rendered, and
// nothing that looks like a token, a file path or a request id is ever shown.
import { INFLUENCER_TILES, INFLUENCER_LIMITS, INFLUENCER_MEDIA_MODES, INFLUENCER_STATE_LABELS, POST_STATE_LABELS, INFLUENCER_RULES, tileGroupsFor, defaultTiles, influencerLaunchRequest, influencerPrompt, describeTiles, featureClipCostUsd } from './influencer-catalog.mjs';
import { AGENT_RATE_CARD_V2 } from './agent-catalog.mjs';

export const INFLUENCER_STYLES_HREF = '/influencer-ui.css?v=71.32';
const ID24 = /^[a-f0-9]{24}$/, HANDLE = /^[A-Za-z0-9_]{1,15}$/, REFERENCE_ID = /^[a-f0-9]{64}\.(?:png|jpg|webp)$/;
const MEDIA_PATH = /^\/influencer-media\/[a-f0-9]{24}\/(?:master|sheet|[a-f0-9]{24})\.(?:png|mp4)$/;
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const ACCOUNT_STATES = new Set(['connected', 'revoked', 'disconnected']);
const POLL_MS = 2000, POLL_FOR_MS = 300000, MONEY = /^\$\d{1,6}\.\d{2,3}$/;

const number = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
/** Plain text for display: control characters removed, length bounded. */
export const safeText = (value, max = 240) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max) : '';
/** USD micro as money ('$0.01', '$0.65'); null when the value is not a non-negative number. */
export function usdMicro(value) { const n = number(value); if (n === null || n < 0) return null; const dollars = n / 1e6; return '$' + dollars.toFixed(dollars !== 0 && dollars < 0.01 ? 3 : 2); }
/** The published charges of the option as money strings (the catalog's rate card, else the shipped v2 card); `feature` maps each daily feature clip length to its price. */
export function influencerCosts(rateCard) {
  const card = rateCard && typeof rateCard === 'object' ? rateCard : {}, pick = key => number(card[key]) ?? AGENT_RATE_CARD_V2[key] ?? 0;
  const seconds = INFLUENCER_LIMITS.videoSeconds, numbers = Object.fromEntries(['imageUsd', 'editUsd', 'mediaCheckUsd', 'videoSecondUsd', 'videoOverheadUsd'].map(key => [key, pick(key)]));
  return { image: usdMicro(pick('imageUsd')), edit: usdMicro(pick('editUsd') || pick('imageUsd')), clip: usdMicro(pick('videoSecondUsd') * seconds + pick('videoOverheadUsd')), check: usdMicro(pick('mediaCheckUsd')), post: usdMicro(pick('xPostUsd')), postLink: usdMicro(pick('xPostLinkUsd')), seconds, feature: Object.fromEntries(INFLUENCER_LIMITS.featureClipSeconds.map(length => [length, usdMicro(featureClipCostUsd(length, numbers))])) };
}
/** The daily feature clip lengths a host offers, from its catalog (a 30-second clip needs video joining on the host); [] when it offers none or the catalog predates the option. */
export function featureClipLengths(info) {
  const raw = Array.isArray(info?.featureClipLengths) ? info.featureClipLengths : [];
  return INFLUENCER_LIMITS.featureClipSeconds.filter(length => raw.some(value => Number(value) === length));
}
/** 'Off' or '15 seconds · $1.91': an option line of the feature clip select. */
export const featureClipLabel = (seconds, costs) => seconds ? seconds + ' seconds' + (costs?.feature?.[seconds] ? ' · ' + costs.feature[seconds] : '') : 'Off';
/** 'https://x.com/<handle>' for a valid handle, else ''. */
export const xProfileUrl = handle => HANDLE.test(String(handle || '')) ? 'https://x.com/' + handle : '';
/** A link to X the server gave (profile or post): https on an X host only; else the handle's profile, else ''. */
export function safeXUrl(url, handle = '') {
  try { const parsed = new URL(String(url || '')); if (parsed.protocol === 'https:' && X_HOSTS.has(parsed.hostname) && !parsed.username && !parsed.password) return parsed.href; } catch { /* not a url */ }
  return xProfileUrl(handle);
}
/** A generated-media path the server published (/influencer-media/<agent>/<file>.png|mp4); anything else renders nothing. */
export const safeMediaUrl = url => MEDIA_PATH.test(String(url || '')) ? String(url) : '';
export const influencerAvatarUrl = influencer => safeMediaUrl(influencer?.avatarUrl);
const safeHandle = value => HANDLE.test(String(value || '')) ? String(value) : '';
const stateLabel = view => INFLUENCER_STATE_LABELS[view?.state] || safeText(view?.stateLabel, 40) || '';
const timeAgo = (value, now) => { const at = number(value); if (!(at > 0)) return ''; const seconds = Math.max(0, Math.round((now - at) / 1000)); if (seconds < 60) return 'just now'; if (seconds < 3600) return Math.round(seconds / 60) + ' min ago'; if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago'; return Math.round(seconds / 86400) + ' d ago'; };
const timeUntil = (value, now) => { const at = number(value); if (!(at > 0)) return ''; const seconds = Math.round((at - now) / 1000); if (seconds <= 0) return 'now'; if (seconds < 3600) return 'in ' + Math.max(1, Math.round(seconds / 60)) + ' min'; if (seconds < 172800) return 'in ' + (seconds / 3600).toFixed(1) + ' h'; return 'in ' + Math.round(seconds / 86400) + ' d'; };
const exactTime = value => { const at = number(value); return at > 0 ? new Date(at).toLocaleString() : ''; };
const kilobytes = bytes => (bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' KB';
const pageOrigin = window => { try { const location = window?.location; if (typeof location?.origin === 'string' && location.origin && location.origin !== 'null') return location.origin; return new URL(String(location?.href || '')).origin; } catch { return ''; } };
const pageHash = window => { const location = window?.location; if (typeof location?.hash === 'string') return location.hash; try { return new URL(String(location?.href || '')).hash; } catch { return ''; } };

export function ensureInfluencerStyles(document) {
  if (!document?.head || document.getElementById('influencer-ui-styles')) return;
  const link = document.createElement('link'); link.id = 'influencer-ui-styles'; link.rel = 'stylesheet'; link.href = INFLUENCER_STYLES_HREF; document.head.append(link);
}

// ---- availability, settings, validation and the summary line ---------------------------------------------------------
/** What the host offers, from the agent catalog's `influencer` object (absent or closed = not available). */
export function influencerAvailability(catalog) {
  if (!catalog || typeof catalog !== 'object') return { known: false, open: false, xOpen: false, mediaOpen: false, dryRun: false, reason: 'Checking AI influencer availability…', xReason: '', mediaReason: '', limits: INFLUENCER_LIMITS, rateCard: null, featureClipLengths: [], rules: INFLUENCER_RULES };
  const info = catalog.influencer && typeof catalog.influencer === 'object' ? catalog.influencer : null;
  const open = info?.open === true, xOpen = open && info.xOpen === true, mediaOpen = open && info.mediaOpen === true;
  return { known: true, open, xOpen, mediaOpen, dryRun: info?.dryRun === true, reason: open ? '' : 'Not available on this host right now.', xReason: xOpen ? '' : 'Posting to X is not configured on this host.', mediaReason: mediaOpen ? '' : 'Character generation is not configured on this host.', limits: info?.limits && typeof info.limits === 'object' ? { ...INFLUENCER_LIMITS, ...info.limits } : INFLUENCER_LIMITS, rateCard: info?.rateCard && typeof info.rateCard === 'object' ? info.rateCard : null, featureClipLengths: mediaOpen ? featureClipLengths(info) : [], rules: Array.isArray(info?.rules) && info.rules.length ? info.rules.map(rule => safeText(rule, 600)).filter(Boolean) : INFLUENCER_RULES };
}
/**
 * The creator's influencer settings as the form holds them, raw, for influencerLaunchRequest(): every input is named
 * influencer*, numbers travel as typed (an empty field takes the catalogue default), tiles only for the chosen kind.
 * `{ enabled: false }` when the option is off or the inputs are absent.
 */
export function influencerSettings(form) {
  const field = name => { try { return form?.elements?.namedItem?.(name) ?? null; } catch { return null; } };
  const text = name => { const node = field(name); return node == null ? '' : String(node.value ?? ''); };
  const checked = name => { const node = field(name); if (!node) return false; if (typeof node.checked === 'boolean') return node.checked; return node.value === 'on' || node.value === 'true'; };
  if (!checked('influencerEnabled')) return { enabled: false };
  const kind = text('influencerTile_kind') === 'mascot' ? 'mascot' : 'person', tiles = {};
  for (const group of tileGroupsFor(kind)) tiles[group.key] = group.key === 'kind' ? kind : text('influencerTile_' + group.key);
  const character = checked('influencerCharacter'), media = text('influencerMedia') || 'images';
  // The feature clip select keeps its value while the character or clips are off; the settings say 0 then, as the catalogue requires.
  return { enabled: true, postToX: checked('influencerPostToX'), xAccountId: text('influencerXAccountId'), cadenceHours: text('influencerCadenceHours'), dailyPosts: text('influencerDailyPosts'), coinLink: checked('influencerCoinLink'), character, source: text('influencerSource') || 'tiles', kind, tiles, referenceId: text('influencerReferenceId'), media, dailyImages: text('influencerDailyImages'), dailyVideos: text('influencerDailyVideos'), featureClipSeconds: character && media === 'video' ? text('influencerFeatureClipSeconds') || '0' : '0' };
}
/** The daily feature clip the settings ask for (0 when off, when the character or clips are off, or when the value is not a catalogue length). */
const featureClipOf = settings => { const seconds = number(settings?.featureClipSeconds) || 0; return settings?.character && settings.media === 'video' && INFLUENCER_LIMITS.featureClipSeconds.includes(seconds) ? seconds : 0; };
/** '' when the settings can launch, else one sentence: the host's availability first, then the catalogue's own complaint. */
export function influencerProblem(settings, { catalog = null, busy = false } = {}) {
  if (!settings || typeof settings !== 'object' || !settings.enabled) return '';
  const availability = influencerAvailability(catalog);
  if (!availability.known) return 'Wait for the AI influencer availability check.';
  if (!availability.open) return 'The AI influencer option is not available on this host right now. Switch it off to launch.';
  if (settings.postToX && !availability.xOpen) return 'Posting to X is not available on this host. Switch Post to X off.';
  if (settings.character && !availability.mediaOpen) return 'Character generation is not available on this host. Switch Character off.';
  const feature = featureClipOf(settings);
  if (feature && !availability.featureClipLengths.includes(feature)) return 'A ' + feature + '-second daily feature clip is not available on this host. Choose ' + (availability.featureClipLengths.map(length => length + ' seconds').join(' or ') || 'Off') + (availability.featureClipLengths.length ? ' or Off.' : '.');
  if (busy) return 'Wait for the reference art upload to finish.';
  try { influencerLaunchRequest(settings); return ''; } catch (error) { return safeText(error?.message, 300) || 'Check the AI influencer settings.'; }
}
/** The preview-card line: "posts to @handle every 6 h, up to 4/day with the coin link; character from tiles, pictures and clips, one 15-second feature clip a day" ('' when off). */
export function influencerSummary(settings, { accounts = [] } = {}) {
  if (!settings || typeof settings !== 'object' || !settings.enabled) return '';
  const parts = [];
  if (settings.postToX) {
    const account = (Array.isArray(accounts) ? accounts : []).find(row => row && row.id === settings.xAccountId), cadence = number(settings.cadenceHours) || INFLUENCER_LIMITS.cadenceDefault, posts = number(settings.dailyPosts) || INFLUENCER_LIMITS.dailyPostsDefault;
    parts.push((account && safeHandle(account.handle) ? 'posts to @' + account.handle : 'posts to X (connect an account)') + ' every ' + cadence + ' h, up to ' + posts + '/day' + (settings.coinLink ? ' with the coin link' : ''));
  }
  if (settings.character) { const mode = INFLUENCER_MEDIA_MODES.find(item => item.id === settings.media), feature = featureClipOf(settings); parts.push('character from ' + (settings.source === 'reference' ? 'reference art' : 'tiles') + (mode ? ', ' + mode.name.toLowerCase() : '') + (feature ? ', one ' + feature + '-second feature clip a day' : '')); }
  return parts.length ? parts.join('; ') : 'on, nothing chosen yet';
}

// ---- reference art ----------------------------------------------------------------------------------------------------
/** PNG, JPEG or WebP by magic bytes, within the size limit: { ok, type } or { ok: false, error }. */
export function inspectReferenceImage(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : bytes ? new Uint8Array(bytes) : new Uint8Array(0);
  if (data.length > INFLUENCER_LIMITS.referenceBytes) return { ok: false, error: 'The reference image is too large. Use at most ' + (INFLUENCER_LIMITS.referenceBytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MB.' };
  if (data.length < 16) return { ok: false, error: 'Choose a PNG, JPEG or WebP image.' };
  const ascii = (from, to) => String.fromCharCode(...data.subarray(from, to));
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => data[index] === byte)) return { ok: true, type: 'png' };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { ok: true, type: 'jpg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ok: true, type: 'webp' };
  return { ok: false, error: 'Choose a PNG, JPEG or WebP image.' };
}
/** Standard base64 of bytes, built in chunks so a 1.5 MB image never spreads a megabyte of arguments. */
export function bytesToBase64(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []); let text = '';
  for (let at = 0; at < data.length; at += 0x8000) text += String.fromCharCode.apply(null, data.subarray(at, at + 0x8000));
  return btoa(text);
}
async function fileBytes(file) {
  if (typeof file?.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result)); reader.onerror = () => reject(Error('The file could not be read.')); reader.readAsArrayBuffer(file); });
}

// ---- the X connection ---------------------------------------------------------------------------------------------------
/** What the X callback left in the page hash: { connected: id } | { error: text } | null. The hash may also carry `agent`. */
export function xReturnFromHash(hash) {
  const text = String(hash || '').replace(/^#/, '').replace(/#/g, '&'); if (!text) return null;
  let params; try { params = new URLSearchParams(text); } catch { return null; }
  const id = params.get('x-connected'); if (id && ID24.test(id)) return { connected: id };
  if (params.has('x-error')) return { error: safeText(params.get('x-error'), 200) || 'The X connection did not complete.' };
  return null;
}
/**
 * Run on page load. When the X callback landed this page in the popup, the result goes to the opener as a
 * `curve-x-connected` / `curve-x-error` message for this origin only and the popup closes; without an opener the result
 * is returned for the page itself to show. The hash is cleared either way so a reload does not replay it.
 */
export function handleXReturn({ window } = {}) {
  if (!window) return null;
  const hash = pageHash(window), back = xReturnFromHash(hash); if (!back) return null;
  const origin = pageOrigin(window), opener = window.opener; let posted = false;
  if (opener && opener !== window && typeof opener.postMessage === 'function' && origin) {
    try { opener.postMessage(back.connected ? { type: 'curve-x-connected', id: back.connected } : { type: 'curve-x-error', message: back.error }, origin); posted = true; } catch { posted = false; }
  }
  try { const location = window.location; if (typeof location?.hash === 'string' && typeof window.history?.replaceState === 'function') window.history.replaceState(null, '', location.pathname + location.search + (/(^|[&#])agent(?:=[^&#]*)?([&#]|$)/.test(hash.replace(/^#/, '')) ? '#agent' : '')); } catch { /* the hash stays */ }
  if (posted) { try { window.close(); } catch { /* the user closes it */ } }
  return { ...back, posted };
}
/** A `message` event from the popup, accepted only from this origin with the exact shape: { connected } | { error } | null. */
export function validXMessage(event, origin) {
  if (!event || !origin || event.origin !== origin) return null;
  const data = event.data; if (!data || typeof data !== 'object') return null;
  if (data.type === 'curve-x-connected' && ID24.test(String(data.id || ''))) return { connected: String(data.id) };
  if (data.type === 'curve-x-error') return { error: safeText(data.message, 200) || 'The X connection did not complete.' };
  return null;
}
/** An account row as the server lists it, with only the fields the page shows; null when it is not one. */
export function xAccountView(row) {
  if (!row || typeof row !== 'object' || !ID24.test(String(row.id || '')) || !safeHandle(row.handle)) return null;
  return { id: String(row.id), handle: String(row.handle), displayName: safeText(row.displayName, 60), state: ACCOUNT_STATES.has(row.state) ? row.state : 'connected', stateReason: safeText(row.stateReason, 200), agentMint: typeof row.agentMint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.agentMint) ? row.agentMint : null, connectedAt: number(row.connectedAt), lastPostAt: number(row.lastPostAt), postsToday: number(row.postsToday) ?? 0 };
}
/**
 * The connect flow shared by the launch step and the coin card: GET /connect for the authorize URL, a popup, then the
 * account list polled every 2 s for up to 5 minutes and the popup's same-origin message. `request(path, body)` carries the
 * session. `onConnected(id)` fires once for an account that was not connected before; `onChange()` after every change.
 */
export function createXConnect({ document, window = document?.defaultView, request, returnTo = 'launchpad', clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, openWindow = null, onChange = () => {}, onConnected = () => {}, onError = () => {} } = {}) {
  const origin = pageOrigin(window);
  let accounts = [], available = null, loaded = false, loading = null, connecting = false, disposed = false, pollTimer = null, pollUntil = 0, known = null, pendingUrl = '', generation = 0;
  const onMessage = event => { if (disposed) return; const back = validXMessage(event, origin); if (!back) return; if (back.connected) { stopPolling(); void load(); } else { stopPolling(); onError(back.error); } };
  window?.addEventListener?.('message', onMessage);
  function stopPolling() { if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; } }
  function startPolling() { pollUntil = clock() + POLL_FOR_MS; if (pollTimer === null) pollTimer = setTimer(() => { if (disposed || clock() > pollUntil) { stopPolling(); return; } void load(); }, POLL_MS); }
  /** Reads the account list once at a time (a second call joins the read in flight); a newly connected account fires onConnected. */
  function load() {
    if (disposed) return Promise.resolve(); if (loading) return loading;
    const version = generation;
    loading = (async () => {
      onChange();
      try {
        const data = await request('/api/launchpad/x/accounts');
        if (disposed || version !== generation) return;
        accounts = (Array.isArray(data?.accounts) ? data.accounts : []).map(xAccountView).filter(Boolean); available = typeof data?.available === 'boolean' ? data.available : available; loaded = true;
        const connected = accounts.filter(row => row.state === 'connected').map(row => row.id);
        if (known) { const fresh = connected.filter(id => !known.has(id)); if (fresh.length) { stopPolling(); onConnected(fresh[fresh.length - 1]); } }
        known = new Set(connected);
      } catch (error) { if (!disposed && version === generation) onError(safeText(error?.message, 200) || 'The X account list could not be read.'); }
      finally { if (version === generation) { loading = null; onChange(); } }
    })();
    return loading;
  }
  async function connect() {
    if (disposed || connecting) return; connecting = true; pendingUrl = ''; onChange();
    try {
      const data = await request('/api/launchpad/x/connect?returnTo=' + encodeURIComponent(returnTo)); if (disposed) return;
      let url = ''; try { const parsed = new URL(String(data?.url || '')); if (parsed.protocol === 'https:') url = parsed.href; } catch { url = ''; }
      if (!url) throw Error('X did not return a sign-in link. Try again in a moment.');
      const opener = openWindow || ((target, name, features) => window.open(target, name, features));
      let popup = null; try { popup = opener(url, 'curve-x', 'popup,width=600,height=750'); } catch { popup = null; }
      if (!popup) pendingUrl = url;
      if (!known) await load();
      startPolling();
    } catch (error) { if (!disposed) onError(safeText(error?.message, 200) || 'The X connection could not be started.'); }
    finally { if (!disposed) { connecting = false; onChange(); } }
  }
  async function disconnect(id) {
    if (disposed || !ID24.test(String(id || ''))) return false;
    const data = await request('/api/launchpad/x/disconnect', { xAccountId: id }); if (disposed) return false;
    accounts = (Array.isArray(data?.accounts) ? data.accounts : []).map(xAccountView).filter(Boolean); known = new Set(accounts.filter(row => row.state === 'connected').map(row => row.id)); loaded = true; onChange(); return true;
  }
  return {
    get accounts() { return accounts.slice(); }, get connected() { return accounts.filter(row => row.state === 'connected'); }, get available() { return available; }, get loaded() { return loaded; }, get loading() { return loading !== null; }, get connecting() { return connecting; }, get polling() { return pollTimer !== null; }, get pendingUrl() { return pendingUrl; }, origin,
    load, connect, disconnect, startPolling, stopPolling,
    reset() { generation++; stopPolling(); accounts = []; available = null; loaded = false; loading = null; known = null; pendingUrl = ''; },
    destroy() { if (disposed) return; disposed = true; generation++; stopPolling(); window?.removeEventListener?.('message', onMessage); },
  };
}

// ---- the launch step ----------------------------------------------------------------------------------------------------
const CADENCE_TEXT = hours => 'Every ' + hours + ' hour' + (hours === 1 ? '' : 's') + (hours === 24 ? ' (once a day)' : '');
/** '$1.31 for 10 seconds, $1.91 for 15 or $3.76 for 30' from influencerCosts(). */
const FEATURE_COST_TEXT = costs => { const lengths = INFLUENCER_LIMITS.featureClipSeconds.filter(length => costs?.feature?.[length]), parts = lengths.map((length, index) => costs.feature[length] + ' for ' + length + (index === 0 ? ' seconds' : '')); return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' or ' + parts.at(-1) : parts[0] || ''; };
const DISCLOSURE = Object.freeze({
  character: 'AI influencer: the character is an original, fictional adult (or a non-human mascot) generated from tiles or your own reference art. No real people, celebrities, brand mascots or minors; the platform refuses references that look like one.',
  x: 'You keep the X account the agent posts to and can disconnect it at any time. You are responsible for X’s rules, including labelling the account as automated and its AI-generated content as X requires.',
  costs: costs => 'Influencer costs come from the agent’s operating credit at the published rate card: ' + costs.image + ' per picture (' + costs.edit + ' for an edited one), ' + costs.clip + ' per ' + costs.seconds + '-second clip, ' + costs.check + ' per consistency check, ' + costs.post + ' per post or ' + costs.postLink + ' per post with the coin link. A daily feature clip, when you turn one on, costs ' + FEATURE_COST_TEXT(costs) + ' and runs only when it fits the agent’s day budget (at most 20% of the credit it started the day with). Nothing is generated or posted without credit.',
  platform: 'Launchpad can pause an influencer, hide its posts on the coin page or disable the option at any time. Nothing an influencer posts is financial advice.',
});
/**
 * The "AI influencer (optional)" block of the AI Agent settings. `root` is the fieldset the launch page ships (hidden
 * until this mounts); `form` the launch form; `fetcher(url, options)` and `token()` carry the session; `catalog()` the
 * agent catalog (its `influencer` object says what the host offers); `coin()` the typed name and symbol for the preview.
 * sync() re-renders what changed and returns the summary line for the preview card; settings() and problem() are what the
 * launch page reads.
 */
export function createInfluencerStep({ document, window = document.defaultView, form, root, fetcher = null, token = () => '', catalog = () => null, coin = () => ({}), clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, openWindow = null } = {}) {
  ensureInfluencerStyles(document);
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const EventType = window?.Event || globalThis.Event;
  const bump = node => { try { node.dispatchEvent(new EventType('change', { bubbles: true })); } catch { /* no listeners */ } };
  const input = (type, name, id, attrs = {}) => { const node = el('input'); node.type = type; node.setAttribute('name', name); node.name = name; if (id) node.id = id; for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; };
  const toggle = (name, id, title, copy) => { const label = el('label', null, 'launch-agent-toggle launch-influencer-toggle'); const box = input('checkbox', name, id); const text = el('span'); text.append(el('strong', title), el('small', copy), el('small', '', 'launch-agent-lock launch-influencer-lock')); text.lastChild.hidden = true; text.lastChild.setAttribute('data-influencer-reason', ''); label.append(box, text); return { label, box, reason: text.lastChild }; };
  const chip = (name, value, text, { checked = false, title = '' } = {}) => { const label = el('label', null, 'launch-influencer-chip'); const radio = input('radio', name, ''); radio.value = value; radio.checked = checked; if (checked) radio.setAttribute('checked', ''); const copy = el('span', text); if (title) label.title = title; label.append(radio, copy); return label; };
  const chips = (name, options, current, labelledBy) => { const row = el('div', null, 'launch-influencer-chips'); row.setAttribute('role', 'radiogroup'); if (labelledBy) row.setAttribute('aria-labelledby', labelledBy); for (const option of options) row.append(chip(name, option.id, option.label || option.name, { checked: option.id === current, title: option.summary || '' })); return row; };
  const numberField = (name, id, label, { min, max, value, hint }) => { const wrap = el('label', null, 'launch-influencer-number'); wrap.append(el('span', label, 'launch-influencer-label')); const node = input('number', name, id, { min, max, step: 1, inputmode: 'numeric' }); node.value = String(value); wrap.append(node); if (hint) wrap.append(el('span', hint, 'launch-agent-setting-range')); return { wrap, node }; };
  const request = async (path, body) => {
    if (!fetcher) throw Error('The launch page is not connected.');
    const response = await fetcher(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'x-control-token': String(token() || ''), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(Error(safeText(data?.error, 300) || 'The request failed.'), { status: response.status }); return data;
  };
  // ---- static frame -------------------------------------------------------------------------------------------------
  root.hidden = false; root.classList.add('launch-influencer');
  const status = root.querySelector('#launch-influencer-status') || (() => { const node = el('p', '', 'help launch-influencer-status'); node.id = 'launch-influencer-status'; node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); root.append(node); return node; })();
  const body = root.querySelector('#launch-influencer') || (() => { const node = el('div', null, 'launch-influencer-body'); node.id = 'launch-influencer'; root.append(node); return node; })();
  body.replaceChildren();
  const master = toggle('influencerEnabled', 'launch-influencer-enabled', 'Add an AI influencer', 'Off by default. Turn it on to let the agent post to an X account you connect, appear as an original fictional character, or both.');
  master.label.classList.add('launch-influencer-master');
  const layers = el('div', null, 'launch-influencer-layers'); layers.hidden = true;
  // Post to X.
  const xToggle = toggle('influencerPostToX', 'launch-influencer-post', 'Post to X', 'The agent queues short posts; the platform delivers them from the X account you connect, within the daily cap, and adds the coin link when you allow it. You keep the account.');
  const xBody = el('div', null, 'launch-influencer-layer launch-influencer-x'); xBody.hidden = true;
  const xStatus = el('p', '', 'help launch-influencer-x-status'); xStatus.id = 'launch-influencer-x-status'; xStatus.setAttribute('role', 'status'); xStatus.setAttribute('aria-live', 'polite');
  const accountsHead = el('span', 'X account', 'launch-influencer-label'); accountsHead.id = 'launch-influencer-accounts-label';
  const accountsList = el('div', null, 'launch-influencer-accounts'); accountsList.id = 'launch-influencer-accounts'; accountsList.setAttribute('role', 'radiogroup'); accountsList.setAttribute('aria-labelledby', accountsHead.id);
  const xAccountId = input('hidden', 'influencerXAccountId', 'launch-influencer-x-account');
  const xActions = el('div', null, 'launch-influencer-actions'), connectButton = el('button', 'Connect X', 'small-button'); connectButton.type = 'button'; connectButton.id = 'launch-influencer-connect';
  const popupLink = el('a', 'Open X in a new tab ↗', 'launch-influencer-popup-link'); popupLink.target = '_blank'; popupLink.rel = 'noopener noreferrer'; popupLink.hidden = true;
  xActions.append(connectButton, popupLink);
  const cadenceWrap = el('label', null, 'launch-influencer-select'); cadenceWrap.append(el('span', 'Posting cadence', 'launch-influencer-label'));
  const cadence = el('select'); cadence.setAttribute('name', 'influencerCadenceHours'); cadence.name = 'influencerCadenceHours'; cadence.id = 'launch-influencer-cadence';
  for (const hours of INFLUENCER_LIMITS.cadenceHours) { const option = el('option', CADENCE_TEXT(hours)); option.value = String(hours); if (hours === INFLUENCER_LIMITS.cadenceDefault) { option.setAttribute('selected', ''); option.selected = true; } cadence.append(option); }
  cadenceWrap.append(cadence, el('span', 'At most one post per run, and never sooner than this after the last one.', 'launch-agent-setting-range'));
  const dailyPosts = numberField('influencerDailyPosts', 'launch-influencer-daily-posts', 'Posts per day', { min: INFLUENCER_LIMITS.dailyPostsMin, max: INFLUENCER_LIMITS.dailyPostsMax, value: INFLUENCER_LIMITS.dailyPostsDefault, hint: INFLUENCER_LIMITS.dailyPostsMin + '–' + INFLUENCER_LIMITS.dailyPostsMax + ' per UTC day' });
  const coinLinkLabel = el('label', null, 'launch-checkbox launch-influencer-check'), coinLink = input('checkbox', 'influencerCoinLink', 'launch-influencer-coin-link'); coinLink.checked = true; coinLink.setAttribute('checked', '');
  const coinLinkText = el('span', ''); coinLinkLabel.append(coinLink, coinLinkText);
  const xGrid = el('div', null, 'launch-influencer-grid'); xGrid.append(cadenceWrap, dailyPosts.wrap);
  xBody.append(accountsHead, accountsList, xAccountId, xActions, xStatus, xGrid, coinLinkLabel);
  // Character.
  const charToggle = toggle('influencerCharacter', 'launch-influencer-character', 'Character', 'An original, fictional adult character (or a non-human mascot) generated from tiles or your own reference art. Every picture and clip is checked against its master portrait before anything is posted.');
  const charBody = el('div', null, 'launch-influencer-layer launch-influencer-char'); charBody.hidden = true;
  const sourceHead = el('span', 'Build the character', 'launch-influencer-label'); sourceHead.id = 'launch-influencer-source-label';
  const sourceChips = chips('influencerSource', [{ id: 'tiles', label: 'Build from tiles' }, { id: 'reference', label: 'Upload reference art' }], 'tiles', sourceHead.id); sourceChips.classList.add('launch-influencer-source');
  const tilesHost = el('div', null, 'launch-influencer-tiles'); tilesHost.id = 'launch-influencer-tiles';
  const defaults = defaultTiles('person'), groupNodes = new Map();
  for (const group of INFLUENCER_TILES) {
    const section = el('div', null, 'launch-influencer-group'); section.dataset.group = group.key;
    const head = el('div', null, 'launch-influencer-group-head'), title = el('h4', group.label); title.id = 'launch-influencer-group-' + group.key; head.append(title); if (group.hint) head.append(el('p', group.hint));
    section.append(head, chips('influencerTile_' + group.key, group.options, group.key === 'kind' ? 'person' : defaults[group.key] ?? group.options[0].id, title.id));
    tilesHost.append(section); groupNodes.set(group.key, section);
  }
  const preview = el('div', null, 'launch-agent-rule launch-influencer-preview'); preview.id = 'launch-influencer-preview'; preview.append(el('span', 'What the pictures will show', 'launch-agent-rule-label'), el('span', '', 'launch-influencer-preview-text'));
  const referenceBox = el('div', null, 'launch-influencer-reference'); referenceBox.hidden = true;
  const referenceLabel = el('label', null, 'launch-influencer-file'); referenceLabel.append(el('span', 'Reference art (PNG, JPEG or WebP, up to 1.5 MB)', 'launch-influencer-label'));
  const referenceFile = input('file', 'influencerReferenceFile', 'launch-influencer-reference-file', { accept: 'image/png,image/jpeg,image/webp' }); referenceLabel.append(referenceFile);
  const referenceId = input('hidden', 'influencerReferenceId', 'launch-influencer-reference-id');
  const referencePreview = el('div', null, 'launch-influencer-reference-preview'); referencePreview.hidden = true;
  const referenceImage = el('img'); referenceImage.alt = 'Your reference art'; referenceImage.hidden = true; referencePreview.append(referenceImage);
  const referenceStatus = el('p', '', 'help launch-influencer-reference-status'); referenceStatus.id = 'launch-influencer-reference-status'; referenceStatus.setAttribute('role', 'status'); referenceStatus.setAttribute('aria-live', 'polite');
  referenceBox.append(referenceLabel, referenceId, referencePreview, referenceStatus, el('p', 'Must be your own original art of a fictional adult character. Not a photo of a real person. The platform refuses references that look like a real person, a known character or a minor.', 'help launch-influencer-reference-note'));
  const mediaHead = el('span', 'Media in posts', 'launch-influencer-label'); mediaHead.id = 'launch-influencer-media-label';
  const mediaChips = chips('influencerMedia', INFLUENCER_MEDIA_MODES, 'images', mediaHead.id); mediaChips.classList.add('launch-influencer-media');
  const dailyImages = numberField('influencerDailyImages', 'launch-influencer-daily-images', 'Pictures per day', { min: 0, max: INFLUENCER_LIMITS.dailyImagesMax, value: INFLUENCER_LIMITS.dailyImagesDefault, hint: '0–' + INFLUENCER_LIMITS.dailyImagesMax + ' per UTC day' });
  const dailyVideos = numberField('influencerDailyVideos', 'launch-influencer-daily-videos', 'Clips per day', { min: 0, max: INFLUENCER_LIMITS.dailyVideosMax, value: INFLUENCER_LIMITS.dailyVideosDefault, hint: '0–' + INFLUENCER_LIMITS.dailyVideosMax + ' per UTC day · ' + INFLUENCER_LIMITS.videoSeconds + '-second clips' });
  // Daily feature clip (v71.32): one longer clip per UTC day, the lengths the host offers, priced from the rate card.
  const featureWrap = el('label', null, 'launch-influencer-select launch-influencer-feature'); featureWrap.hidden = true; featureWrap.append(el('span', 'Daily feature clip', 'launch-influencer-label'));
  const featureSelect = el('select'); featureSelect.setAttribute('name', 'influencerFeatureClipSeconds'); featureSelect.name = 'influencerFeatureClipSeconds'; featureSelect.id = 'launch-influencer-feature-clip';
  const featureHint = el('span', '', 'launch-agent-setting-range'); featureWrap.append(featureSelect, featureHint);
  let featureOptionsKey = '';
  const renderFeatureOptions = (lengths, costText) => {
    const key = JSON.stringify([lengths, costText.feature]); if (key === featureOptionsKey) return; featureOptionsKey = key;
    const current = Number(featureSelect.value) || 0; featureSelect.replaceChildren();
    for (const seconds of [0, ...lengths]) { const option = el('option', featureClipLabel(seconds, costText)); option.value = String(seconds); if (seconds === (lengths.includes(current) ? current : 0)) { option.setAttribute('selected', ''); option.selected = true; } featureSelect.append(option); }
    featureHint.textContent = lengths.length ? 'One per UTC day on top of the 5-second clips; the agent asks for it when it has something worth a longer clip. The 30-second clip needs video joining on the host' + (lengths.includes(30) ? '' : ' (not available here)') + '.' : 'Not available on this host.';
  };
  const mediaGrid = el('div', null, 'launch-influencer-grid'); mediaGrid.append(dailyImages.wrap, dailyVideos.wrap, featureWrap);
  const costs = el('p', '', 'help launch-influencer-costs'); costs.id = 'launch-influencer-costs';
  charBody.append(sourceHead, sourceChips, tilesHost, preview, referenceBox, mediaHead, mediaChips, mediaGrid, costs);
  const error = el('p', '', 'launch-agent-setting-error launch-influencer-error'); error.id = 'launch-influencer-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  layers.append(xToggle.label, xBody, charToggle.label, charBody);
  body.append(master.label, layers, error);
  // ---- state ----------------------------------------------------------------------------------------------------------
  let disposed = false, version = '', uploading = false, uploadGeneration = 0, xMessage = '', xBad = false, loadedFor = null, lastTokenSeen = '', pendingReturn = null, referenceObjectUrl = '';
  const field = name => { try { return form?.elements?.namedItem?.(name) ?? null; } catch { return null; } };
  const xConnect = createXConnect({ document, window, request, returnTo: 'launchpad', clock, setTimer, clearTimer, openWindow, onChange: () => { if (!disposed) render(); }, onConnected: id => { if (disposed) return; selectAccount(id); const account = xConnect.accounts.find(row => row.id === id); say(account ? '@' + account.handle + ' connected.' : 'X account connected.'); }, onError: text => say(text, true) });
  const back = handleXReturn({ window }); if (back && !back.posted) pendingReturn = back;
  function say(text, bad = false) { xMessage = text || ''; xBad = bad; render(); }
  function selectAccount(id) { if (xAccountId.value === id) return; xAccountId.value = ID24.test(String(id || '')) ? id : ''; version = ''; bump(xAccountId); }
  /** The newest connected account that no agent uses yet, else the newest connected one. */
  function preferredAccount(accounts) { const free = accounts.filter(row => row.state === 'connected' && !row.agentMint), connected = accounts.filter(row => row.state === 'connected'), pick = rows => rows.slice().sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0))[0]; return pick(free) || pick(connected) || null; }
  function renderAccounts(accounts) {
    accountsList.replaceChildren();
    const connected = accounts.filter(row => row.state !== 'disconnected');
    if (!connected.length) { accountsList.append(el('p', xConnect.loaded ? 'No X account connected yet. Connect the account the agent will post to; you stay its owner.' : xConnect.loading ? 'Reading your X accounts…' : 'Sign in, then connect the X account the agent will post to.', 'help launch-influencer-empty')); return; }
    for (const account of connected) {
      const row = el('label', null, 'launch-influencer-account' + (account.state === 'connected' ? '' : ' is-revoked')); row.dataset.account = account.id;
      const radio = input('radio', 'influencerXAccountChoice', ''); radio.value = account.id; radio.checked = xAccountId.value === account.id; radio.disabled = account.state !== 'connected';
      const copy = el('span', null, 'launch-influencer-account-copy'); copy.append(el('strong', '@' + account.handle));
      const notes = [account.displayName, account.state === 'connected' ? (account.agentMint ? 'used by another agent' : 'free') : account.stateReason || 'Reconnect this account'].filter(Boolean); copy.append(el('small', notes.join(' · ')));
      const disconnect = el('button', 'Disconnect', 'text-button launch-influencer-disconnect'); disconnect.type = 'button'; disconnect.setAttribute('aria-label', 'Disconnect @' + account.handle); disconnect.onclick = () => void removeAccount(account);
      row.append(radio, copy, disconnect); accountsList.append(row);
    }
  }
  async function removeAccount(account) {
    if (disposed) return; const confirm = window?.confirm ? window.confirm('Disconnect @' + account.handle + ' from Launchpad? An agent using it stops posting.') : true; if (!confirm) return;
    try { await xConnect.disconnect(account.id); if (xAccountId.value === account.id) selectAccount(''); say('@' + account.handle + ' disconnected.'); } catch (e) { say(safeText(e?.message, 200) || 'The account could not be disconnected.', true); }
  }
  async function upload(file) {
    const generation = ++uploadGeneration; referenceId.value = ''; referenceImage.hidden = true; referencePreview.hidden = true; if (referenceObjectUrl) { try { window.URL.revokeObjectURL(referenceObjectUrl); } catch { /* ignore */ } referenceObjectUrl = ''; }
    if (!file) { referenceStatus.textContent = ''; referenceStatus.classList.remove('negative'); bump(referenceId); return; }
    uploading = true; referenceStatus.textContent = 'Checking the image…'; referenceStatus.classList.remove('negative'); version = ''; render();
    try {
      const bytes = await fileBytes(file); if (disposed || generation !== uploadGeneration) return;
      const inspected = inspectReferenceImage(bytes); if (!inspected.ok) throw Error(inspected.error);
      referenceStatus.textContent = 'Uploading ' + kilobytes(bytes.length) + ' ' + inspected.type.toUpperCase() + '…';
      const saved = await request('/api/launchpad/agents/influencer/reference', { data: bytesToBase64(bytes) }); if (disposed || generation !== uploadGeneration) return;
      if (!REFERENCE_ID.test(String(saved?.referenceId || ''))) throw Error('The upload did not complete. Try again.');
      referenceId.value = saved.referenceId;
      try { referenceObjectUrl = window.URL.createObjectURL(file); referenceImage.src = referenceObjectUrl; referenceImage.hidden = false; referencePreview.hidden = false; } catch { referenceImage.hidden = true; }
      referenceStatus.textContent = 'Reference art uploaded (' + kilobytes(bytes.length) + ' ' + inspected.type.toUpperCase() + '). It is used only to create this character.';
    } catch (e) { if (disposed || generation !== uploadGeneration) return; referenceId.value = ''; referenceStatus.textContent = safeText(e?.message, 300) || 'The image could not be uploaded.'; referenceStatus.classList.add('negative'); try { referenceFile.value = ''; } catch { /* some browsers keep it */ } }
    finally { if (generation === uploadGeneration) { uploading = false; version = ''; bump(referenceId); render(); } }
  }
  function onInput(event) {
    const target = event.target; if (!target || !target.name) return;
    // The hidden fields change programmatically and are followed by an explicit render; the launch form still hears them.
    if (target.name === 'influencerXAccountId' || target.name === 'influencerReferenceId') return;
    if (target.name === 'influencerXAccountChoice') { if (target.checked) selectAccount(target.value); return; }
    if (target.name === 'influencerReferenceFile') { if (event.type === 'change') void upload(target.files?.[0] || null); return; }
    if (target.name === 'influencerTile_kind' && target.checked) version = '';
    render();
  }
  root.addEventListener('input', onInput); root.addEventListener('change', onInput);
  connectButton.onclick = () => { say(''); void xConnect.connect(); };
  const settings = () => influencerSettings(form);
  const problem = () => influencerProblem(settings(), { catalog: catalog(), busy: uploading });
  function render() {
    if (disposed) return;
    const availability = influencerAvailability(catalog()), who = coin() || {}, accounts = xConnect.accounts, tokenNow = String(token() || ''), on = master.box.checked, posting = on && xToggle.box.checked;
    if (tokenNow !== lastTokenSeen) { lastTokenSeen = tokenNow; if (!tokenNow) { xConnect.reset(); loadedFor = null; selectAccount(''); } }
    // Accounts load once per session token while the X layer is visible (and again when the token changes).
    if (posting && tokenNow && loadedFor !== tokenNow && !xConnect.loading) { loadedFor = tokenNow; xConnect.reset(); void xConnect.load(); }
    // A connected account arriving from the popup, the poll or the callback hash is chosen when nothing usable is chosen yet.
    if (accounts.length && (!xAccountId.value || !accounts.some(row => row.id === xAccountId.value && row.state === 'connected'))) {
      const returned = pendingReturn?.connected && accounts.some(row => row.id === pendingReturn.connected && row.state === 'connected') ? pendingReturn.connected : '', pick = returned || preferredAccount(accounts)?.id || '';
      if (returned) { pendingReturn = null; xMessage = '@' + accounts.find(row => row.id === returned).handle + ' connected.'; xBad = false; }
      if (pick) selectAccount(pick); else if (xAccountId.value) selectAccount('');
    }
    if (pendingReturn?.error && posting) { xMessage = pendingReturn.error; xBad = true; pendingReturn = null; }
    const current = settings(), enabled = current.enabled, costText = influencerCosts(availability.rateCard), reason = pendingReturn ? (pendingReturn.error ? pendingReturn.error : 'X account connected. Turn on Post to X to use it.') : '';
    const key = JSON.stringify([availability.known, availability.open, availability.xOpen, availability.mediaOpen, availability.dryRun, availability.featureClipLengths, costText, current, who.name, who.symbol, accounts, xConnect.loaded, xConnect.loading && !accounts.length, xConnect.connecting, xConnect.polling, xConnect.pendingUrl, xConnect.available, xMessage, xBad, uploading, referenceStatus.textContent, reason, tokenNow !== '']);
    if (key === version) return; version = key;
    // Availability: the master toggle only locks while it is off, so a creator can always switch the option back off.
    master.box.disabled = !availability.open && !master.box.checked;
    status.textContent = availability.known ? (availability.open ? (availability.dryRun ? 'Dry-run mode: nothing is generated or posted; placeholders stand in for media.' : '') : availability.reason) : availability.reason; status.dataset.state = availability.known ? (availability.open ? 'open' : 'closed') : 'checking';
    if (reason && enabled) status.textContent = reason;
    layers.hidden = !enabled;
    xToggle.box.disabled = enabled && !availability.xOpen && !xToggle.box.checked; xToggle.reason.textContent = availability.known && !availability.xOpen && enabled ? availability.xReason : ''; xToggle.reason.hidden = !xToggle.reason.textContent;
    charToggle.box.disabled = enabled && !availability.mediaOpen && !charToggle.box.checked; charToggle.reason.textContent = availability.known && !availability.mediaOpen && enabled ? availability.mediaReason : ''; charToggle.reason.hidden = !charToggle.reason.textContent;
    xBody.hidden = !(enabled && current.postToX); charBody.hidden = !(enabled && current.character);
    if (!xBody.hidden) {
      renderAccounts(accounts);
      connectButton.textContent = xConnect.connecting ? 'Opening X…' : accounts.some(row => row.state === 'connected') ? 'Connect another X account' : 'Connect X'; connectButton.disabled = xConnect.connecting || !tokenNow;
      popupLink.hidden = !xConnect.pendingUrl; if (xConnect.pendingUrl) popupLink.href = xConnect.pendingUrl;
      xStatus.textContent = xMessage || (xConnect.pendingUrl ? 'The popup was blocked. Open X in a new tab, approve the connection and come back here.' : xConnect.polling ? 'Waiting for X… approve the connection in the window that opened.' : xConnect.available === false ? availability.xReason || 'Posting to X is not available right now.' : ''); xStatus.classList.toggle('negative', xBad);
      coinLinkText.textContent = 'Add the coin page link to every post (' + costText.postLink + ' per post with a link, ' + costText.post + ' without)';
    }
    if (!charBody.hidden) {
      const kind = current.kind; for (const [key, section] of groupNodes) { const group = INFLUENCER_TILES.find(item => item.key === key), applies = kind === 'mascot' ? group.mascot : group.human; section.hidden = !applies; for (const radio of section.querySelectorAll('input')) radio.disabled = !applies; }
      referenceBox.hidden = current.source !== 'reference';
      preview.querySelector('.launch-influencer-preview-text').textContent = influencerPrompt(current.tiles, { name: who.name || '', symbol: who.symbol || '' }) + (current.source === 'reference' ? ' Your reference art guides the character; the tiles fill in the rest.' : '');
      dailyImages.wrap.hidden = current.media === 'text'; dailyVideos.wrap.hidden = current.media !== 'video';
      renderFeatureOptions(availability.featureClipLengths, costText); featureWrap.hidden = current.media !== 'video';
      const featureText = availability.featureClipLengths.length ? ' · one feature clip a day, when you turn it on: ' + FEATURE_COST_TEXT({ feature: Object.fromEntries(availability.featureClipLengths.map(length => [length, costText.feature[length]])) }) : '';
      costs.textContent = costText.image + ' per picture (' + costText.edit + ' edited) · ' + costText.clip + ' per ' + costText.seconds + '-second clip · ' + costText.check + ' per consistency check' + featureText + ', from the agent’s operating credit. Failed or refused generations are not charged.';
    }
    // The disclosure bullets of the agent block speak only while the option is on; the costs bullet quotes the live rate card.
    for (const item of document.querySelectorAll('[data-influencer-disclosure]')) { item.hidden = !enabled; const kindOf = item.getAttribute('data-influencer-disclosure'); if (kindOf === 'costs') item.textContent = DISCLOSURE.costs(costText); else if (DISCLOSURE[kindOf]) item.textContent = DISCLOSURE[kindOf]; }
    const issue = enabled ? problem() : ''; error.textContent = issue; error.hidden = !issue;
    for (const [name, test] of [['influencerDailyPosts', /Daily posts/], ['influencerDailyImages', /Daily pictures|at least one picture/], ['influencerDailyVideos', /Daily clips|at least one picture/], ['influencerCadenceHours', /cadence/i], ['influencerFeatureClipSeconds', /feature clip/i]]) { const node = field(name); if (node?.setAttribute) node.setAttribute('aria-invalid', String(!!issue && test.test(issue))); }
  }
  render();
  return {
    settings, problem,
    /** Re-renders what changed and returns the preview-card line ('' while the option is off). */
    sync() { render(); return influencerSummary(settings(), { accounts: xConnect.accounts }); },
    summary() { return influencerSummary(settings(), { accounts: xConnect.accounts }); },
    render, get uploading() { return uploading; }, get xConnect() { return xConnect; }, get pendingReturn() { return pendingReturn; },
    destroy() { if (disposed) return; disposed = true; uploadGeneration++; xConnect.destroy(); root.removeEventListener('input', onInput); root.removeEventListener('change', onInput); if (referenceObjectUrl) { try { window.URL.revokeObjectURL(referenceObjectUrl); } catch { /* ignore */ } } },
  };
}

// ---- the coin page card -------------------------------------------------------------------------------------------------
/** The server's public influencer view with only the fields the card shows, every url and handle checked; null when it is not a view. */
export function influencerView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const handle = safeHandle(raw.handle), state = INFLUENCER_STATE_LABELS[raw.state] ? raw.state : 'pending', caps = raw.caps && typeof raw.caps === 'object' ? raw.caps : {}, today = raw.today && typeof raw.today === 'object' ? raw.today : {};
  const tiles = raw.tiles && typeof raw.tiles === 'object' && !Array.isArray(raw.tiles) ? describeTiles(raw.tiles) : safeText(raw.tiles, 160);
  const posts = (Array.isArray(raw.posts) ? raw.posts : []).filter(post => post && typeof post === 'object').slice(0, INFLUENCER_LIMITS.postsShown).map(post => { const kind = ['text', 'image', 'video'].includes(post.kind) ? post.kind : 'text'; return { id: ID24.test(String(post.id || '')) ? String(post.id) : '', kind, text: safeText(post.text, 320), state: POST_STATE_LABELS[post.state] ? post.state : 'queued', stateLabel: POST_STATE_LABELS[post.state] || safeText(post.stateLabel, 40) || 'Queued', url: safeXUrl(post.url), mediaUrl: safeMediaUrl(post.mediaUrl), at: number(post.at), postedAt: number(post.postedAt), error: safeText(post.error, 200), feature: kind === 'video' && post.feature === true, seconds: kind === 'video' ? Math.min(60, Math.max(0, Math.round(number(post.seconds) ?? 0))) || INFLUENCER_LIMITS.videoSeconds : 0 }; });
  // Daily feature clip (v71.32): the chosen length, today's use, and what this host offers at which price; an older view carries none.
  const featureRaw = raw.featureClip && typeof raw.featureClip === 'object' ? raw.featureClip : {}, featureLengths = featureClipLengths({ featureClipLengths: featureRaw.lengths }), featureSeconds = INFLUENCER_LIMITS.featureClipSeconds.includes(number(featureRaw.seconds)) ? number(featureRaw.seconds) : 0;
  const money = value => usdMicro(value) ?? (MONEY.test(String(value ?? '')) ? String(value) : null);
  const featureCosts = Object.fromEntries(INFLUENCER_LIMITS.featureClipSeconds.map(length => [length, money(featureRaw.costsUsd && typeof featureRaw.costsUsd === 'object' ? featureRaw.costsUsd[length] : null)]).filter(([, text]) => text));
  const paused = key => typeof raw[key] === 'boolean' ? raw[key] : null;
  return { enabled: raw.enabled !== false, character: raw.character === true, postToX: raw.postToX === true, state, stateLabel: INFLUENCER_STATE_LABELS[state] || safeText(raw.stateLabel, 40), stateReason: safeText(raw.stateReason, 300), handle, xUrl: handle ? safeXUrl(raw.xUrl, handle) : '', avatarUrl: safeMediaUrl(raw.avatarUrl), sheetUrl: safeMediaUrl(raw.sheetUrl), tiles, source: raw.source === 'reference' ? 'reference' : 'tiles', media: INFLUENCER_MEDIA_MODES.some(item => item.id === raw.media) ? raw.media : 'text', caps: { dailyPosts: number(caps.dailyPosts), dailyImages: number(caps.dailyImages), dailyVideos: number(caps.dailyVideos) }, cadenceHours: number(raw.cadenceHours), coinLink: raw.coinLink !== false, today: { posts: number(today.posts) ?? 0, images: number(today.images) ?? 0, videos: number(today.videos) ?? 0, feature: number(today.feature) ?? 0 }, featureClip: { seconds: featureSeconds, usedToday: featureRaw.usedToday === true || (number(today.feature) ?? 0) > 0, available: featureRaw.available === true, lengths: featureLengths, costsUsd: featureCosts, known: !!(raw.featureClip && typeof raw.featureClip === 'object') }, nextPostAt: number(raw.nextPostAt), postingPaused: paused('postingPaused') ?? paused('pausedByCreator'), adminPaused: paused('adminPaused') ?? paused('pausedByPlatform'), regenerationsLeft: number(raw.regenerationsLeft), posts, rules: Array.isArray(raw.rules) && raw.rules.length ? raw.rules.map(rule => safeText(rule, 600)).filter(Boolean) : INFLUENCER_RULES };
}
/**
 * The Influencer card of a coin page's agent section: avatar and state, the X handle, what the character is, cadence and
 * today's counters, the post feed and, for the creator (`owner()`), the controls. `request(path, body)` carries the
 * session; setView() takes the view the agent detail carries (null = no card), refresh() reads GET /influencer?mint=.
 */
export function createInfluencerCard({ document, window = document.defaultView, mint, request, clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, openWindow = null, owner = () => false, xReturn = undefined } = {}) {
  ensureInfluencerStyles(document);
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const element = el('section', null, 'agent-panel agent-panel-wide influencer-card'); element.hidden = true; element.setAttribute('aria-label', 'AI influencer');
  const head = el('div', null, 'influencer-head'), avatar = el('div', null, 'influencer-avatar'), copy = el('div', null, 'influencer-copy'), title = el('h3', 'Influencer'), pills = el('p', null, 'influencer-state'), statePill = el('span', '', 'agent-pill influencer-pill'), handleLink = el('a', '', 'influencer-handle'), reason = el('p', '', 'agent-muted influencer-reason');
  handleLink.target = '_blank'; handleLink.rel = 'noopener noreferrer'; handleLink.hidden = true; pills.append(statePill, handleLink); copy.append(title, pills, reason); head.append(avatar, copy);
  const facts = el('dl', null, 'agent-dl influencer-facts'), feed = el('div', null, 'agent-feed influencer-posts'), controlsHost = el('div', null, 'influencer-controls'), status = el('p', '', 'agent-status influencer-status'), rules = el('details', null, 'influencer-rules'), rulesList = el('ul');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); rules.append(el('summary', 'How the influencer works'), rulesList); controlsHost.hidden = true;
  element.append(head, facts, feed, controlsHost, status, rules);
  let view = null, versionKey = '', controlsKey = '', busy = false, disposed = false, message = '', bad = false, xConnect = null, pendingReturn = xReturn === undefined ? null : xReturn;
  if (xReturn === undefined) { const back = handleXReturn({ window }); if (back && !back.posted) pendingReturn = back; }
  const say = (text, isBad = false) => { message = text || ''; bad = isBad; status.textContent = message; status.dataset.bad = String(isBad); };
  const control = async (body, { working = 'Saving…', done = 'Saved.' } = {}) => {
    if (busy || disposed) return null; busy = true; say(working); render();
    try { const data = await request('/api/launchpad/agents/influencer', { mint, ...body }); if (disposed) return null; const next = influencerView(data?.influencer); if (next) setView(data.influencer); say(done); return next; }
    catch (error) { if (!disposed) say(safeText(error?.message, 300) || 'The change could not be saved.', true); return null; }
    finally { if (!disposed) { busy = false; render(); } }
  };
  function connectFlow() {
    if (xConnect) return xConnect;
    xConnect = createXConnect({ document, window, request, returnTo: 'coin:' + mint, clock, setTimer, clearTimer, openWindow, onChange: () => { if (!disposed) render(); }, onConnected: id => { if (!disposed) void control({ xAccountId: id }, { working: 'Attaching the X account…', done: 'X account attached. Posting resumes on the next run.' }); }, onError: text => say(text, true) });
    return xConnect;
  }
  function renderFacts(rows) { facts.replaceChildren(); for (const [label, value] of rows) { if (value == null || value === '') continue; const row = el('div'), dd = el('dd'); if (typeof value === 'object' && typeof value.nodeType === 'number') dd.append(value); else dd.textContent = String(value); row.append(el('dt', label), dd); facts.append(row); } }
  function renderPosts(now) {
    feed.replaceChildren();
    if (!view.posts.length) { feed.append(el('p', view.postToX ? 'No posts yet. The agent posts when it has something worth saying, at most once per run.' : 'This character does not post to X; its pictures appear with the agent’s updates.', 'agent-muted')); return; }
    for (const post of view.posts) {
      const row = el('article', null, 'agent-event influencer-post'); row.dataset.kind = post.kind; row.dataset.state = post.state; if (post.feature) row.dataset.feature = 'true';
      const headRow = el('div', null, 'agent-event-head'), pill = el('span', post.stateLabel, 'agent-pill influencer-post-pill'); pill.dataset.state = post.state; headRow.append(pill);
      if (post.kind !== 'text') { const kindPill = el('span', post.kind === 'video' ? (post.feature ? 'Feature clip · ' + post.seconds + ' s' : 'Clip') : 'Picture', 'agent-pill influencer-post-kind'); if (post.kind === 'video') kindPill.title = post.seconds + '-second clip'; headRow.append(kindPill); }
      const when = el('time', timeAgo(post.postedAt || post.at, now) || '—'); if (number(post.postedAt || post.at)) when.title = exactTime(post.postedAt || post.at); headRow.append(el('strong', post.state === 'posted' ? 'Posted to X' : post.stateLabel), when);
      row.append(headRow); if (post.text) row.append(el('p', post.text, 'influencer-post-text'));
      if (post.mediaUrl) { const media = el('div', null, 'influencer-media'); if (post.mediaUrl.endsWith('.mp4')) { const video = el('video'); video.controls = true; video.preload = 'none'; video.setAttribute('preload', 'none'); video.setAttribute('controls', ''); video.setAttribute('playsinline', ''); video.src = post.mediaUrl; if (view.avatarUrl) video.poster = view.avatarUrl; media.append(video); } else { const img = el('img'); img.loading = 'lazy'; img.alt = 'Picture of the character posted with this update'; img.src = post.mediaUrl; img.onerror = () => media.remove(); media.append(img); } row.append(media); }
      const links = el('div', null, 'agent-event-links'); if (post.url) { const link = el('a', 'View on X ↗', 'agent-link'); link.href = post.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link); } if (post.error && post.state !== 'posted') links.append(el('span', post.error, 'agent-muted')); if (links.childElementCount) row.append(links);
      feed.append(row);
    }
  }
  function renderControls() {
    const mine = owner() === true && !!request; controlsHost.hidden = !mine; if (!mine) { controlsHost.replaceChildren(); controlsKey = ''; return; }
    const paused = view.postingPaused === true || (view.postingPaused === null && view.state === 'paused' && view.adminPaused !== true), canRegenerate = view.character && ['ready', 'failed'].includes(view.state) && (view.regenerationsLeft === null || view.regenerationsLeft > 0);
    const key = JSON.stringify([view.postToX, view.character, view.media, view.caps, view.cadenceHours, view.coinLink, view.featureClip, paused, canRegenerate, view.regenerationsLeft, view.handle, view.state, busy, xConnect?.connecting, xConnect?.pendingUrl, xConnect?.polling]);
    if (key === controlsKey) return; controlsKey = key; controlsHost.replaceChildren();
    const form = el('form', null, 'influencer-form'); form.onsubmit = event => event.preventDefault();
    form.append(el('h4', 'Creator controls'));
    const grid = el('div', null, 'influencer-form-grid');
    const cadenceLabel = el('label', 'Posting cadence'), cadence = el('select'); cadence.name = 'cadenceHours'; for (const hours of INFLUENCER_LIMITS.cadenceHours) { const option = el('option', CADENCE_TEXT(hours)); option.value = String(hours); cadence.append(option); } cadence.value = String(view.cadenceHours || INFLUENCER_LIMITS.cadenceDefault); cadenceLabel.append(cadence);
    const posts = el('label', 'Posts per day (' + INFLUENCER_LIMITS.dailyPostsMin + '–' + INFLUENCER_LIMITS.dailyPostsMax + ')'), postsInput = el('input'); postsInput.type = 'number'; postsInput.name = 'dailyPosts'; postsInput.min = String(INFLUENCER_LIMITS.dailyPostsMin); postsInput.max = String(INFLUENCER_LIMITS.dailyPostsMax); postsInput.step = '1'; postsInput.value = String(view.caps.dailyPosts ?? INFLUENCER_LIMITS.dailyPostsDefault); posts.append(postsInput);
    const coinLinkLabel = el('label', null, 'influencer-check'), coinLink = el('input'); coinLink.type = 'checkbox'; coinLink.name = 'coinLink'; coinLink.checked = view.coinLink; coinLinkLabel.append(coinLink, el('span', 'Add the coin page link to posts'));
    if (view.postToX) grid.append(cadenceLabel, posts, coinLinkLabel);
    let mediaSelect = null, imagesInput = null, videosInput = null, featureSelect = null;
    if (view.character) {
      const mediaLabel = el('label', 'Media in posts'); mediaSelect = el('select'); mediaSelect.name = 'media'; for (const mode of INFLUENCER_MEDIA_MODES) { const option = el('option', mode.name); option.value = mode.id; option.title = mode.summary; mediaSelect.append(option); } mediaSelect.value = view.media; mediaLabel.append(mediaSelect);
      const images = el('label', 'Pictures per day (0–' + INFLUENCER_LIMITS.dailyImagesMax + ')'); imagesInput = el('input'); imagesInput.type = 'number'; imagesInput.name = 'dailyImages'; imagesInput.min = '0'; imagesInput.max = String(INFLUENCER_LIMITS.dailyImagesMax); imagesInput.step = '1'; imagesInput.value = String(view.caps.dailyImages ?? INFLUENCER_LIMITS.dailyImagesDefault); images.append(imagesInput);
      const videos = el('label', 'Clips per day (0–' + INFLUENCER_LIMITS.dailyVideosMax + ')'); videosInput = el('input'); videosInput.type = 'number'; videosInput.name = 'dailyVideos'; videosInput.min = '0'; videosInput.max = String(INFLUENCER_LIMITS.dailyVideosMax); videosInput.step = '1'; videosInput.value = String(view.caps.dailyVideos ?? INFLUENCER_LIMITS.dailyVideosDefault); videos.append(videosInput);
      // Daily feature clip (v71.32): Off or one of the lengths this host offers, each with its price; only with clips on.
      const feature = el('label', 'Daily feature clip'); featureSelect = el('select'); featureSelect.name = 'featureClipSeconds';
      const lengths = view.featureClip.lengths.includes(view.featureClip.seconds) || !view.featureClip.seconds ? view.featureClip.lengths : [...view.featureClip.lengths, view.featureClip.seconds].sort((a, b) => a - b);
      for (const seconds of [0, ...lengths]) { const option = el('option', featureClipLabel(seconds, { feature: view.featureClip.costsUsd })); option.value = String(seconds); if (seconds && !view.featureClip.lengths.includes(seconds)) option.title = 'Not available on this host right now.'; featureSelect.append(option); }
      featureSelect.value = String(view.featureClip.seconds); feature.append(featureSelect, el('small', view.featureClip.lengths.length ? 'One per UTC day on top of the ' + INFLUENCER_LIMITS.videoSeconds + '-second clips; it runs when it fits the agent’s day budget.' : 'Not available on this host.', 'agent-muted'));
      feature.hidden = !view.featureClip.known;
      const syncMedia = () => { images.hidden = mediaSelect.value === 'text'; videos.hidden = mediaSelect.value !== 'video'; feature.hidden = !view.featureClip.known || mediaSelect.value !== 'video'; }; mediaSelect.onchange = syncMedia; syncMedia();
      grid.append(mediaLabel, images, videos, feature);
    }
    form.append(grid);
    const actions = el('div', null, 'agent-actions influencer-actions');
    const save = el('button', 'Save settings', 'small-button'); save.type = 'button'; save.disabled = busy; save.dataset.influencerAction = 'save';
    save.onclick = () => { const body = {}; if (view.postToX) { body.cadenceHours = Number(cadence.value); body.dailyPosts = Number(postsInput.value); body.coinLink = coinLink.checked; } if (view.character) { body.media = mediaSelect.value; body.dailyImages = mediaSelect.value === 'text' ? 0 : Number(imagesInput.value); body.dailyVideos = mediaSelect.value === 'video' ? Number(videosInput.value) : 0; if (view.featureClip.known) body.featureClipSeconds = mediaSelect.value === 'video' ? Number(featureSelect.value) || 0 : 0; } void control(body, { working: 'Saving…', done: 'Settings saved. They apply from the next post.' }); };
    actions.append(save);
    if (view.postToX) { const pause = el('button', paused ? 'Resume posting' : 'Pause posting', 'small-button'); pause.type = 'button'; pause.disabled = busy; pause.dataset.influencerAction = 'pause'; pause.onclick = () => void control({ pausePosting: !paused }, { working: paused ? 'Resuming…' : 'Pausing…', done: paused ? 'Posting resumed.' : 'Posting paused. Queued posts are dropped; nothing is sent until you resume.' }); actions.append(pause); }
    if (canRegenerate) { const regenerate = el('button', 'Regenerate character' + (view.regenerationsLeft !== null ? ' (' + view.regenerationsLeft + ' left)' : ''), 'small-button'); regenerate.type = 'button'; regenerate.disabled = busy; regenerate.dataset.influencerAction = 'regenerate'; regenerate.onclick = () => { const confirmed = window?.confirm ? window.confirm('Create the character again from the same tiles or reference art? The new portrait replaces the current one and is charged like the first.') : true; if (confirmed) void control({ regenerate: true }, { working: 'Starting a new character…', done: 'A new character is being created. This takes a few minutes.' }); }; actions.append(regenerate); }
    if (view.postToX) {
      const flow = connectFlow(), connect = el('button', flow.connecting ? 'Opening X…' : view.handle ? 'Reconnect X' : 'Connect X', 'small-button'); connect.type = 'button'; connect.disabled = busy || flow.connecting; connect.dataset.influencerAction = 'connect'; connect.onclick = () => { say(''); void flow.connect(); }; actions.append(connect);
      if (flow.pendingUrl) { const link = el('a', 'Open X in a new tab ↗', 'agent-link'); link.href = flow.pendingUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link); }
      if (view.handle) { const detach = el('button', 'Detach X account', 'text-button'); detach.type = 'button'; detach.disabled = busy; detach.dataset.influencerAction = 'detach'; detach.onclick = () => { const confirmed = window?.confirm ? window.confirm('Detach @' + view.handle + ' from this agent? It stops posting until you connect an account again. The X account stays yours.') : true; if (confirmed) void control({ detachX: true }, { working: 'Detaching…', done: 'X account detached. Posting stops until you connect one again.' }); }; actions.append(detach); }
    }
    form.append(actions, el('p', 'Changes apply from the next post and are recorded as a public revision. Daily caps stay within the platform’s limits; the character can be created again at most ' + INFLUENCER_LIMITS.regenerations + ' times.', 'agent-muted'));
    controlsHost.append(form);
  }
  function render() {
    if (disposed) return;
    if (!view) { element.hidden = true; return; }
    const now = clock(), key = JSON.stringify([view, owner() === true, busy]);
    element.hidden = false;
    if (pendingReturn && owner() === true && !busy && view.postToX && request) { const back = pendingReturn; pendingReturn = null; if (back.connected) void control({ xAccountId: back.connected }, { working: 'Attaching the X account…', done: 'X account attached. Posting resumes on the next run.' }); else say(back.error, true); }
    if (key !== versionKey) {
      versionKey = key;
      avatar.replaceChildren(); avatar.dataset.state = view.state;
      if (view.avatarUrl) { const img = el('img'); img.src = view.avatarUrl; img.alt = 'The character’s master portrait'; img.loading = 'lazy'; img.onerror = () => { img.remove(); avatar.append(el('span', view.character ? 'AI' : 'X')); }; avatar.append(img); } else avatar.append(el('span', view.character ? 'AI' : 'X'));
      statePill.textContent = view.stateLabel; statePill.dataset.state = view.state;
      handleLink.hidden = !view.handle; if (view.handle) { handleLink.textContent = '@' + view.handle + ' ↗'; handleLink.href = view.xUrl || xProfileUrl(view.handle); }
      reason.textContent = view.stateReason || (view.state === 'ready' && view.postToX && view.nextPostAt ? 'Next post ' + timeUntil(view.nextPostAt, now) + ' at the earliest.' : view.state === 'generating' ? 'The master portrait is being created and checked. This takes a few minutes.' : view.state === 'pending' ? 'The influencer starts once the coin is live.' : ''); reason.hidden = !reason.textContent;
      const mode = INFLUENCER_MEDIA_MODES.find(item => item.id === view.media), counters = [];
      if (view.postToX) counters.push('posts ' + view.today.posts + '/' + (view.caps.dailyPosts ?? '—'));
      if (view.character && view.media !== 'text') counters.push('pictures ' + view.today.images + '/' + (view.caps.dailyImages ?? '—'));
      if (view.character && view.media === 'video') counters.push('clips ' + view.today.videos + '/' + (view.caps.dailyVideos ?? '—'));
      const feature = view.character && view.media === 'video' && view.featureClip.seconds ? view.featureClip : null;
      if (feature) counters.push('feature clip ' + view.today.feature + '/' + INFLUENCER_LIMITS.featureClipPerDay);
      const sheet = view.sheetUrl ? (() => { const link = el('a', 'Turnaround sheet ↗', 'agent-link'); link.href = view.sheetUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link; })() : null;
      renderFacts([['Character', view.character ? (view.tiles || (view.source === 'reference' ? 'From your reference art' : 'From tiles')) + (view.source === 'reference' && view.tiles ? ' · guided by reference art' : '') : 'None (posts are words only)'], ['Media', view.character ? mode?.name || '—' : null], ['Feature clip', feature ? feature.seconds + ' seconds, once a day' + (feature.costsUsd[feature.seconds] ? ' (' + feature.costsUsd[feature.seconds] + ')' : '') + (feature.usedToday ? ' · used today' : feature.available ? ' · available today' : feature.lengths.includes(feature.seconds) ? '' : ' · not available on this host right now') : null], ['Posts to', view.postToX ? (view.handle ? '@' + view.handle : 'X (no account attached)') : 'Nowhere (character only)'], ['Cadence', view.postToX && view.cadenceHours ? CADENCE_TEXT(view.cadenceHours).toLowerCase().replace(/^e/, 'E') + (view.coinLink ? ' · coin link added' : '') : null], ['Today', counters.join(' · ') || null], ['Next post', view.postToX ? (view.nextPostAt ? timeUntil(view.nextPostAt, now) : 'when there is something to say') : null], ['Sheet', sheet]]);
      renderPosts(now);
      rulesList.replaceChildren(); for (const rule of view.rules) rulesList.append(el('li', rule));
    }
    renderControls();
    status.textContent = message; status.dataset.bad = String(bad);
  }
  function setView(raw) { const next = raw === null ? null : influencerView(raw); if (raw !== undefined) view = next; render(); }
  async function refresh() {
    if (disposed || !request || !mint) return;
    try { const data = await request('/api/launchpad/agents/influencer?mint=' + encodeURIComponent(mint)); if (disposed) return; if (data && 'influencer' in data) setView(data.influencer); }
    catch { /* the detail view feeds the card; a host without the option shows nothing */ }
  }
  return { element, setView, refresh, render, get view() { return view; }, get busy() { return busy || !!xConnect?.connecting; }, destroy() { if (disposed) return; disposed = true; xConnect?.destroy(); element.replaceChildren(); } };
}

// ---- directory badge --------------------------------------------------------------------------------------------------
/** The small "on X" marker of a directory card (a link to the profile) or "AI character" for a character without X; null without an influencer. */
export function createInfluencerBadge(document, influencer, { className = 'influencer-badge' } = {}) {
  if (!influencer || typeof influencer !== 'object') return null;
  const handle = safeHandle(influencer.handle), label = stateLabel(influencer), character = influencer.character === true;
  if (!handle && !character) return null;
  const node = document.createElement(handle ? 'a' : 'span'); node.className = className; node.dataset.state = INFLUENCER_STATE_LABELS[influencer.state] ? influencer.state : 'pending'; node.dataset.influencer = handle ? 'x' : 'character';
  node.textContent = handle ? 'on X' : 'AI character';
  if (handle) { node.href = safeXUrl(influencer.xUrl, handle); node.target = '_blank'; node.rel = 'noopener noreferrer'; node.title = '@' + handle + (label ? ' · ' + label : ''); node.setAttribute('aria-label', 'Posts to X as @' + handle + (label ? '. ' + label : '')); }
  else { node.title = label ? 'AI character · ' + label : 'AI character'; node.setAttribute('aria-label', node.title); }
  return node;
}
