// Coin text and social links of a new launch, shared by the Pump.fun (pump-classic) and Meteora services so a
// creator's text is cleaned the same way on both venues. Dependency-free.
//
// Text: leading and trailing whitespace is removed. Inside, a line break or tab, with the spaces around it, becomes
// one space: coin metadata is shown on one line (Explore, the coin page, wallets) and Launchpad's lists drop control
// characters, so "Line one.\nLine two." would otherwise read "Line one.Line two.". Other control characters are
// removed. Limits counted in bytes (names and tickers, which are written onchain) count emoji and accented letters
// as 2 to 4.
//
// Links (the launch page should apply the same rules before sending):
//   website   an https address whose host has a dot; "example.com" becomes https://example.com/.
//   X         "@name" or "name" (1-15 letters, digits or _) becomes https://x.com/name; otherwise an https address as above.
//   Telegram  "@name" or "name" (4-32 letters, digits or _, starting with a letter) becomes https://t.me/name; otherwise as above.
// A handle sent with https:// in front ("https://@name", "https://name", as older launch pages did) is read as the handle.
// Anything else is refused with a message naming the field: a host without a dot, http://, a user name or password
// before the host, a handle the network does not allow, or more than 200 characters.

const invalid = message => { throw Object.assign(Error(message), { statusCode: 400, code: 'COIN_TEXT' }); };
const CONTROLS = /[\x00-\x08\x0e-\x1f\x7f]/g, BREAKS = /\s*[\t\n\v\f\r\u0085\u2028\u2029][\s\u0085]*/g;
const size = (text, bytes) => bytes ? Buffer.byteLength(text, 'utf8') : [...text].length;
const textOf = (value, message) => value === undefined || value === null ? '' : typeof value === 'string' ? value : invalid(message);

/** One line of text: trimmed, each inner line break or tab (with the spaces around it) as one space, other control characters removed. */
export const oneLine = value => String(value ?? '').replace(CONTROLS, '').replace(BREAKS, ' ').trim();

/**
 * A coin name, ticker or description as one line of text. `max` counts UTF-8 bytes when `bytes` is set (fields
 * written onchain), otherwise characters. A missing required field or one over its limit is a 400 naming the field.
 */
export function coinText(value, { field, max, bytes = false, required = false }) {
  const text = oneLine(textOf(value, `Enter the ${field} as text.`));
  if (!text) { if (required) invalid(`Enter a ${field}.`); return ''; }
  if (size(text, bytes) > max) invalid(`The ${field} is too long. Use at most ${max.toLocaleString('en-US')} characters${bytes ? '; emoji and accented letters count as 2 to 4 each' : ''}.`);
  return text;
}

const LINKS = Object.freeze({
  website: { label: 'website', help: 'Enter the website as an https:// address with a domain, like https://example.com.' },
  twitter: { label: 'X', handle: /^[A-Za-z0-9_]{1,15}$/, profile: 'https://x.com/', help: 'Enter X as @handle (up to 15 letters, numbers or _) or a full https:// link, like https://x.com/example.' },
  telegram: { label: 'Telegram', handle: /^[A-Za-z][A-Za-z0-9_]{3,31}$/, profile: 'https://t.me/', help: 'Enter Telegram as @username (4 to 32 letters, numbers or _, starting with a letter) or a full https:// link, like https://t.me/example.' },
});
// "@name" or "name", alone or with https:// in front: no dot, no path, so not an address.
const HANDLE_LIKE = /^(?:https?:\/\/)?@?([^\s\/\\?#@:.]+)\/?$/i, SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A website, X or Telegram link as the https address to store ('' when empty). `kind`: 'website', 'twitter' or 'telegram'. */
export function coinLink(value, kind) {
  const link = LINKS[kind]; if (!link) throw Error('Unknown link field.');
  const text = oneLine(textOf(value, link.help)); if (!text) return '';
  if ([...text].length > 200) invalid(`The ${link.label} link is too long. Use at most 200 characters.`);
  const bare = HANDLE_LIKE.exec(text);
  if (bare) { if (!link.handle?.test(bare[1])) invalid(link.help); return link.profile + bare[1]; }
  const address = SCHEME.test(text) ? text : 'https://' + text, authority = address.replace(SCHEME, '').replace(/^[\/\\]+/, '').split(/[\/\\?#]/)[0];
  let url; try { url = new URL(address); } catch { invalid(link.help); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || authority.includes('@') || url.username || url.password || !host.includes('.') || host.startsWith('.') || host.endsWith('.')) invalid(link.help);
  if (url.href.length > 300) invalid(`The ${link.label} link is too long. Use at most 200 characters.`);
  return url.href;
}
