// AI influencer (Launchpad v71.30): the shared, inert catalogue used by the launch page, the coin page,
// the docs and the server. An AI Agent launch may add an influencer: an X account the creator
// connected that the agent posts to, a generated original character (from these tiles or the
// creator's own reference art) that appears in its pictures and clips, or both. Nothing here calls
// a provider, posts or spends; the server validates everything again with the same functions.
export const INFLUENCER_VERSION = 1;
export const INFLUENCER_LIMITS = Object.freeze({
  postChars: 280, hashtags: 2, dailyPostsMin: 1, dailyPostsMax: 12, dailyPostsDefault: 4, dailyImagesMax: 6, dailyImagesDefault: 2, dailyVideosMax: 2, dailyVideosDefault: 0,
  cadenceHours: Object.freeze([2, 4, 6, 12, 24]), cadenceDefault: 6, regenerations: 3, referenceBytes: 1536 * 1024, referenceTypes: Object.freeze(['png', 'jpg', 'webp']), briefChars: 240, vibeChars: 0, postsShown: 12,
  videoSeconds: 5, imageResolution: '1080p', postImageResolution: '720p',
  // Daily feature clip (v71.32): one longer clip per UTC day on top of the 5-second clips; 30 s is two 15-second renders joined on the host (offered only when the host can join video).
  featureClipSeconds: Object.freeze([10, 15, 30]), featureClipSegmentSeconds: 15, featureClipPerDay: 1,
});
export const INFLUENCER_MEDIA_MODES = Object.freeze([
  Object.freeze({ id: 'text', name: 'Text only', summary: 'Posts are words only. No media is generated.' }),
  Object.freeze({ id: 'images', name: 'Pictures', summary: 'Posts may carry a picture of the character, within the daily picture cap.' }),
  Object.freeze({ id: 'video', name: 'Pictures and clips', summary: 'Posts may carry a picture or a 5-second clip of the character, within the daily caps.' }),
]);
// Tile groups. `human: true` groups apply to a person-like character; `mascot: true` groups to a
// non-human mascot. Every option carries the prompt fragment the server renders; the ids are what
// the launch request stores. Ages are adult bands only; there is no option below adulthood.
const option = (id, label, prompt, extra = {}) => Object.freeze({ id, label, prompt, ...extra });
const group = (key, label, hint, options, extra = {}) => Object.freeze({ key, label, hint, options: Object.freeze(options), human: true, mascot: true, ...extra });
export const INFLUENCER_TILES = Object.freeze([
  group('kind', 'Character', 'A person-like character or a non-human mascot. Always original, always fictional.', [
    option('person', 'Person', 'an original fictional adult person'),
    option('mascot', 'Mascot', 'an original non-human cartoon mascot'),
  ]),
  group('presentsAs', 'Presents as', 'How the character reads at a glance.', [
    option('woman', 'Woman', 'a woman'), option('man', 'Man', 'a man'), option('androgynous', 'Androgynous', 'an androgynous person'),
  ], { mascot: false }),
  group('age', 'Age', 'Adults only. The character is never a minor.', [
    option('20s', 'Twenties', 'in their mid-twenties'), option('30s', 'Thirties', 'in their thirties'), option('40s', 'Forties', 'in their forties'), option('50plus', 'Fifty and up', 'in their late fifties'),
  ], { mascot: false }),
  group('build', 'Build', '', [
    option('slim', 'Slim', 'slim build'), option('athletic', 'Athletic', 'athletic build'), option('average', 'Average', 'average build'), option('sturdy', 'Sturdy', 'broad, sturdy build'), option('plus', 'Plus-size', 'plus-size build'),
  ], { mascot: false }),
  group('skin', 'Skin tone', '', [
    option('light', 'Light', 'light skin'), option('mediumLight', 'Medium-light', 'medium-light skin'), option('medium', 'Medium', 'medium skin'), option('mediumDeep', 'Medium-deep', 'medium-deep skin'), option('deep', 'Deep', 'deep skin'),
  ], { mascot: false }),
  group('hair', 'Hair', '', [
    option('shortDark', 'Short dark', 'short dark hair'), option('shortLight', 'Short light', 'short light hair'), option('longDark', 'Long dark', 'long dark hair'), option('longLight', 'Long light', 'long light hair'), option('curly', 'Curly', 'voluminous curly hair'), option('braids', 'Braids', 'long braids'), option('buzz', 'Buzz cut', 'a buzz cut'), option('bright', 'Bright color', 'vividly dyed hair in a bright color'), option('bald', 'Bald', 'a shaved head'),
  ], { mascot: false }),
  group('creature', 'Creature', 'What the mascot is.', [
    option('robot', 'Robot', 'a friendly rounded robot'), option('cat', 'Cat', 'a cartoon cat'), option('fox', 'Fox', 'a cartoon fox'), option('frog', 'Frog', 'a cartoon frog'), option('bear', 'Bear', 'a cartoon bear'), option('alien', 'Alien', 'a small big-eyed alien'), option('blob', 'Blob', 'a smiling gelatinous blob creature'), option('owl', 'Owl', 'a cartoon owl'),
  ], { human: false }),
  group('outfit', 'Outfit', '', [
    option('streetwear', 'Streetwear', 'wearing streetwear'), option('smartCasual', 'Smart casual', 'wearing smart casual clothes'), option('techwear', 'Techwear', 'wearing dark techwear'), option('athleisure', 'Athleisure', 'wearing athleisure'), option('vintage', 'Vintage', 'wearing vintage clothes'), option('formal', 'Formal', 'wearing a tailored suit'), option('cyber', 'Cyberpunk', 'wearing cyberpunk clothing with glowing accents'), option('cozy', 'Cozy', 'wearing a cozy oversized sweater'),
  ]),
  group('style', 'Visual style', 'How pictures and clips are rendered.', [
    option('photoreal', 'Photoreal', 'photorealistic, natural lighting, 85mm lens look'), option('cinematic', 'Cinematic', 'cinematic, dramatic lighting, shallow depth of field'), option('anime', 'Anime', 'clean anime illustration style'), option('render3d', '3D render', 'stylized 3D render, soft studio lighting'), option('illustration', 'Illustration', 'flat vector illustration style'), option('pixel', 'Pixel art', 'detailed pixel art style'),
  ]),
  group('palette', 'Palette', '', [
    option('neon', 'Neon', 'neon color palette'), option('pastel', 'Pastel', 'pastel color palette'), option('mono', 'Monochrome', 'monochrome palette with one accent color'), option('warm', 'Warm', 'warm golden palette'), option('cool', 'Cool', 'cool blue palette'), option('earth', 'Earth', 'earthy natural palette'),
  ]),
  group('setting', 'Usual setting', 'Where the character tends to be.', [
    option('studio', 'Studio', 'in a clean studio'), option('city', 'City', 'in a city street at night'), option('desk', 'Home desk', 'at a home desk with screens'), option('nature', 'Outdoors', 'outdoors in nature'), option('floor', 'Trading floor', 'on a busy trading floor'), option('abstract', 'Abstract', 'against an abstract gradient background'),
  ]),
  group('vibe', 'Vibe', 'The usual expression and energy.', [
    option('confident', 'Confident', 'confident, relaxed expression'), option('playful', 'Playful', 'playful, grinning expression'), option('calm', 'Calm', 'calm, thoughtful expression'), option('mysterious', 'Mysterious', 'mysterious, half-lit expression'), option('nerdy', 'Nerdy', 'curious, nerdy expression'), option('glam', 'Glamorous', 'glamorous, poised expression'),
  ]),
]);
export const INFLUENCER_TILE_KEYS = Object.freeze(INFLUENCER_TILES.map(item => item.key));
export const tileGroup = key => INFLUENCER_TILES.find(item => item.key === key) || null;
export const tileOption = (key, id) => tileGroup(key)?.options.find(item => item.id === id) || null;
/** The tile groups that apply to a kind ('person' | 'mascot'). */
export function tileGroupsFor(kind) { return INFLUENCER_TILES.filter(item => (kind === 'mascot' ? item.mascot : item.human)); }
/** Default tiles: the first option of every group that applies to the kind. */
export function defaultTiles(kind = 'person') { const out = {}; for (const item of tileGroupsFor(kind)) out[item.key] = item.key === 'kind' ? kind : item.options[0].id; return out; }
export const INFLUENCER_STATES = Object.freeze(['pending', 'generating', 'ready', 'failed', 'paused', 'disabled']);
export const INFLUENCER_STATE_LABELS = Object.freeze({ pending: 'Waiting for the coin', generating: 'Creating the character', ready: 'Ready', failed: 'Character failed', paused: 'Posting paused', disabled: 'Off' });
export const POST_STATES = Object.freeze(['queued', 'generating', 'checking', 'uploading', 'posted', 'skipped', 'failed']);
export const POST_STATE_LABELS = Object.freeze({ queued: 'Queued', generating: 'Generating media', checking: 'Checking media', uploading: 'Posting', posted: 'Posted', skipped: 'Skipped', failed: 'Failed' });

const fail = message => { throw Object.assign(Error(message), { statusCode: 400 }); };
const bool = value => value === true || value === 'on' || value === 'true' || value === '1' || value === 1;
const id24 = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const referenceId = value => typeof value === 'string' && /^[a-f0-9]{64}\.(png|jpg|webp)$/.test(value);
const integer = (value, min, max, label, fallback) => { if (value === undefined || value === null || value === '') return fallback; const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number between ${min} and ${max}.`); return n; };
/** Validated tile choices for a kind: unknown keys dropped, missing keys defaulted, unknown ids refused. */
export function normalizeTiles(raw, kind) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, out = { kind };
  for (const item of tileGroupsFor(kind)) { if (item.key === 'kind') continue; const given = input[item.key]; if (given === undefined || given === null || given === '') { out[item.key] = item.options[0].id; continue; } if (!tileOption(item.key, String(given))) fail(`Choose ${/^[aeiou]/i.test(item.label) ? 'an' : 'a'} ${item.label.toLowerCase()} from the list.`); out[item.key] = String(given); }
  return out;
}
/**
 * Normalizes the creator's influencer settings from a launch form. Returns null when the option is
 * off. Everything the server needs beyond shape (that the X account belongs to the creator, that
 * the reference upload exists) is checked on the server.
 */
export function influencerLaunchRequest(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('Describe the influencer before launching.');
  if (!bool(raw.enabled)) return null;
  const postToX = bool(raw.postToX), character = bool(raw.character);
  if (!postToX && !character) fail('Turn on posting to X, a character, or both; otherwise switch the influencer off.');
  const xAccountId = postToX ? String(raw.xAccountId || '') : '';
  if (postToX && !id24(xAccountId)) fail('Connect the X account the agent will post to.');
  const cadenceHours = integer(raw.cadenceHours, 1, 24, 'Posting cadence', INFLUENCER_LIMITS.cadenceDefault);
  if (!INFLUENCER_LIMITS.cadenceHours.includes(cadenceHours)) fail(`Posting cadence must be one of ${INFLUENCER_LIMITS.cadenceHours.join(', ')} hours.`);
  const dailyPosts = integer(raw.dailyPosts, INFLUENCER_LIMITS.dailyPostsMin, INFLUENCER_LIMITS.dailyPostsMax, 'Daily posts', INFLUENCER_LIMITS.dailyPostsDefault);
  const coinLink = raw.coinLink === undefined ? true : bool(raw.coinLink);
  let source = 'none', tiles = null, referenceId_ = '', media = 'text', dailyImages = 0, dailyVideos = 0;
  if (character) {
    source = String(raw.source || 'tiles');
    if (!['tiles', 'reference'].includes(source)) fail('Build the character from tiles or upload reference art.');
    const kind = String(raw.kind || raw.tiles?.kind || 'person');
    if (!['person', 'mascot'].includes(kind)) fail('Choose a person or a mascot.');
    tiles = normalizeTiles(raw.tiles, kind);
    if (source === 'reference') { referenceId_ = String(raw.referenceId || ''); if (!referenceId(referenceId_)) fail('Upload the reference image first.'); }
    media = String(raw.media || 'images');
    if (!INFLUENCER_MEDIA_MODES.some(item => item.id === media)) fail('Choose text only, pictures, or pictures and clips.');
    dailyImages = media === 'text' ? 0 : integer(raw.dailyImages, 0, INFLUENCER_LIMITS.dailyImagesMax, 'Daily pictures', INFLUENCER_LIMITS.dailyImagesDefault);
    dailyVideos = media === 'video' ? integer(raw.dailyVideos, 0, INFLUENCER_LIMITS.dailyVideosMax, 'Daily clips', INFLUENCER_LIMITS.dailyVideosDefault) : 0;
    if (media !== 'text' && dailyImages === 0 && dailyVideos === 0) fail('Allow at least one picture or clip a day, or choose text only.');
  }
  // Daily feature clip: 0 (off) or one of the catalogue lengths; needs a character with clips enabled.
  const featureClipSeconds = integer(raw.featureClipSeconds, 0, 60, 'Daily feature clip', 0);
  if (featureClipSeconds !== 0 && !INFLUENCER_LIMITS.featureClipSeconds.includes(featureClipSeconds)) fail(`The daily feature clip must be off or ${INFLUENCER_LIMITS.featureClipSeconds.join(', ')} seconds.`);
  if (featureClipSeconds !== 0 && (!character || media !== 'video')) fail('A daily feature clip needs a character with pictures and clips enabled.');
  return { version: INFLUENCER_VERSION, postToX, xAccountId, cadenceHours, dailyPosts, coinLink, character, source, tiles, referenceId: referenceId_, media, dailyImages, dailyVideos, featureClipSeconds };
}
/**
 * The fixed appearance paragraph rendered from tiles. The server prefixes it to every image or clip
 * prompt and shows it to the model as the character's description. Catalogue text only.
 */
export function influencerPrompt(tiles, { name = '', symbol = '' } = {}) {
  const kind = tiles?.kind === 'mascot' ? 'mascot' : 'person', parts = [];
  const pick = key => tileOption(key, tiles?.[key])?.prompt || tileGroup(key)?.options[0].prompt || '';
  if (kind === 'mascot') parts.push(`${pick('kind')}: ${pick('creature')}, ${pick('outfit')}`);
  else parts.push(`${pick('kind')}, ${pick('presentsAs')} ${pick('age')}, ${pick('build')}, ${pick('skin')}, ${pick('hair')}, ${pick('outfit')}`);
  parts.push(`${pick('style')}, ${pick('palette')}, ${pick('setting')}, ${pick('vibe')}`);
  const who = name ? `, the face of the coin ${String(name).slice(0, 40)}${symbol ? ` (${String(symbol).slice(0, 12)})` : ''}` : '';
  return `The same original character every time${who}: ${parts.join('; ')}. Not a real person, not a celebrity, not a child; no text, logos, watermarks or captions in the picture.`;
}
/** Short human summary of a character for cards. */
export function describeTiles(tiles) {
  if (!tiles) return '';
  const label = key => tileOption(key, tiles[key])?.label || '';
  return tiles.kind === 'mascot' ? [label('creature'), label('outfit'), label('style')].filter(Boolean).join(' · ') : [label('presentsAs'), label('age'), label('hair'), label('outfit'), label('style')].filter(Boolean).join(' · ');
}
/** How a feature clip of `seconds` is rendered: the segments (each at most featureClipSegmentSeconds) and whether the host must join them. */
export function featureClipPlan(seconds) {
  const total = Number(seconds) || 0; if (!INFLUENCER_LIMITS.featureClipSeconds.includes(total)) return null;
  const segment = INFLUENCER_LIMITS.featureClipSegmentSeconds, segments = [];
  for (let left = total; left > 0; left -= segment) segments.push(Math.min(segment, left));
  return { seconds: total, segments, joined: segments.length > 1 };
}
/** USD micro a feature clip costs at a rate card: the picture it starts from, its check, and every segment's seconds plus overhead. */
export function featureClipCostUsd(seconds, card) {
  const plan = featureClipPlan(seconds); if (!plan || !card) return 0;
  const n = key => Number(card[key]) || 0;
  return (n('editUsd') || n('imageUsd')) + n('mediaCheckUsd') + plan.segments.reduce((sum, length) => sum + n('videoSecondUsd') * length + n('videoOverheadUsd'), 0);
}
const URL_LIKE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|fun|app|ai|co|gg|me|link|site|lol|dev|info|tv|us|uk|eth|sol)\b)/i;
/** Post text as the platform accepts it from the model: plain, bounded, no links, at most two hashtags. Returns {ok, text|error}. */
export function validatePostText(value) {
  const text = String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+\n/g, '\n').trim();
  if (!text) return { ok: false, error: 'The post is empty.' };
  if ([...text].length > INFLUENCER_LIMITS.postChars) return { ok: false, error: `The post is longer than ${INFLUENCER_LIMITS.postChars} characters.` };
  if (URL_LIKE.test(text)) return { ok: false, error: 'Posts cannot contain links; the platform adds the coin link when the creator enabled it.' };
  if ((text.match(/#[\p{L}\p{N}_]+/gu) || []).length > INFLUENCER_LIMITS.hashtags) return { ok: false, error: `Use at most ${INFLUENCER_LIMITS.hashtags} hashtags.` };
  if (/@[A-Za-z0-9_]{1,15}\b/.test(text)) return { ok: false, error: 'Posts cannot mention other accounts.' };
  if (/\$[A-Za-z]{2,10}\b.*\b(?:guaranteed|moon|100x|1000x|can.t lose|risk[- ]free)\b/i.test(text) || /\b(?:guaranteed|risk[- ]free)\b.*\b(?:profit|returns?|gains?|yield)\b/i.test(text)) return { ok: false, error: 'Posts cannot promise price, yield or profit.' };
  return { ok: true, text };
}
export const INFLUENCER_RULES = Object.freeze([
  'The character is an original, fictional adult (or a non-human mascot) generated from tiles or from reference art the creator has the rights to. It is never a real person, a celebrity, a brand mascot or a minor, and the platform refuses references that look like one.',
  'The agent posts only to an X account its creator connected and can disconnect at any time. The creator keeps the account and is responsible for X’s rules, including its automation and AI-content labelling.',
  'Every post is queued by the model and delivered by the platform: words only from the model (no links, no mentions, at most two hashtags, no price promises), media generated and checked by the platform, the coin page link added by the platform when the creator enabled it.',
  'Posts and media are capped per day by the creator (at most 12 posts, 6 pictures and 2 clips, plus one optional 10, 15 or 30-second feature clip) and by the platform, and run only while the agent has operating credit: each picture, clip and post is charged at the published rate card like any other agent cost.',
  'Launchpad can pause an influencer, hide its posts on the coin page or disable the option at any time. Nothing an influencer posts is financial advice.',
]);
