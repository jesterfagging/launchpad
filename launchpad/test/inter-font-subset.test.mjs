import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';

// public/fonts/InterVariable.woff2 is Inter 4.1 (InterVariable.woff2, SIL OFL; the
// full file is in git history, e.g. `git show 486bfbc:public/fonts/InterVariable.woff2`)
// subset to the characters the site renders. Both variation axes and the default
// layout features stay, so kept glyphs render pixel-identically. Characters outside
// the subset (other scripts in coin names) fall back to the system font.
const FONT = new URL('../public/fonts/InterVariable.woff2', import.meta.url);
const FEATURES = 'calt,ccmp,locl,kern,mark,mkmk,tnum';
// Symbols used by the UI for which Inter 4.1 itself has no glyph: they always
// rendered with a fallback font, before and after subsetting.
const INTER_LACKS = new Set([...'⋮⌁⌕⏹█◈◎☐☑⚪✕✦⧉']);
// Coin and pair catalogues hold issuer-provided names in any script; not UI text.
const CATALOGUES = new Set(['launch-assets.mjs', 'quote-display-assets.mjs', 'meteora-extra-assets.mjs']);
const KNOWN_TAGS = ['cmap','head','hhea','hmtx','maxp','name','OS/2','post','cvt ','fpgm','glyf','loca','prep','CFF ','VORG','EBDT','EBLC','gasp','hdmx','kern','LTSH','PCLT','VDMX','vhea','vmtx','BASE','GDEF','GPOS','GSUB','EBSC','JSTF','MATH','CBDT','CBLC','COLR','CPAL','SVG ','sbix','acnt','avar','bdat','bloc','bsln','cvar','fdsc','feat','fmtx','fvar','gvar','hsty','just','lcar','mort','morx','opbd','prop','trak','Zapf','Silf','Glat','Gloc','Feat','Sill'];

// Minimal WOFF2 reader: table directory + Brotli stream; cmap, fvar, GSUB and GPOS
// are never transformed, so they are read directly from the decompressed stream.
function woff2Tables(bytes) {
  assert.equal(bytes.toString('latin1', 0, 4), 'wOF2');
  const numTables = bytes.readUInt16BE(12), compressedSize = bytes.readUInt32BE(20);
  let at = 48;
  const base128 = () => { let value = 0; for (let i = 0; i < 5; i++) { const byte = bytes[at++]; value = value * 128 + (byte & 0x7f); if (!(byte & 0x80)) return value; } throw Error('bad UIntBase128'); };
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const flags = bytes[at++], index = flags & 0x3f, version = flags >> 6;
    const tag = index === 63 ? bytes.toString('latin1', at, at += 4) : KNOWN_TAGS[index];
    const length = base128(), transformed = ['glyf', 'loca'].includes(tag) ? version === 0 : version !== 0;
    entries.push({ tag, length: transformed ? base128() : length });
  }
  const data = brotliDecompressSync(bytes.subarray(at, at + compressedSize)), tables = new Map();
  let offset = 0;
  for (const entry of entries) { tables.set(entry.tag, data.subarray(offset, offset + entry.length)); offset += entry.length; }
  return tables;
}

function cmapCodePoints(cmap) {
  const records = [];
  for (let i = 0; i < cmap.readUInt16BE(2); i++) records.push({ platform: cmap.readUInt16BE(4 + i * 8), encoding: cmap.readUInt16BE(6 + i * 8), offset: cmap.readUInt32BE(8 + i * 8) });
  const points = new Set();
  const full = records.find(r => r.platform === 3 && r.encoding === 10 && cmap.readUInt16BE(r.offset) === 12);
  if (full) {
    const t = cmap.subarray(full.offset), groups = t.readUInt32BE(12);
    for (let g = 0; g < groups; g++) { const start = t.readUInt32BE(16 + g * 12), end = t.readUInt32BE(20 + g * 12), glyph = t.readUInt32BE(24 + g * 12); for (let c = start; c <= end; c++) if (glyph + c - start) points.add(c); }
    return points;
  }
  const bmp = records.find(r => r.platform === 3 && r.encoding === 1 && cmap.readUInt16BE(r.offset) === 4);
  const t = cmap.subarray(bmp.offset), segments = t.readUInt16BE(6) / 2;
  const ends = 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
  for (let s = 0; s < segments; s++) {
    const end = t.readUInt16BE(ends + s * 2), start = t.readUInt16BE(starts + s * 2), delta = t.readInt16BE(deltas + s * 2), range = t.readUInt16BE(ranges + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      const glyph = range ? t.readUInt16BE(ranges + s * 2 + range + (c - start) * 2) : c;
      if (glyph && (glyph + delta) & 0xffff) points.add(c);
    }
  }
  return points;
}

const layoutFeatures = table => { const list = table.readUInt16BE(6), count = table.readUInt16BE(list); return new Set(Array.from({ length: count }, (_, i) => table.toString('latin1', list + 2 + i * 6, list + 6 + i * 6))); };
const fixed = (table, at) => table.readInt32BE(at) / 65536;
const ranges = points => { const sorted = [...points].sort((a, b) => a - b), out = []; for (const p of sorted) { const last = out.at(-1); if (last && last[1] === p - 1) last[1] = p; else out.push([p, p]); } return out.map(([a, b]) => 'U+' + a.toString(16).toUpperCase().padStart(4, '0') + (a === b ? '' : '-' + b.toString(16).toUpperCase().padStart(4, '0'))).join(','); };

test('the Inter subset keeps both variation axes, the default and tabular-figure features, and a small size', async () => {
  const bytes = await readFile(FONT), tables = woff2Tables(bytes);
  assert(bytes.length < 160 * 1024, `InterVariable.woff2 is ${bytes.length} bytes; the subset is about 85 KB (full Inter is 352 KB)`);
  for (const tag of ['cmap', 'glyf', 'gvar', 'fvar', 'HVAR', 'GSUB', 'GPOS', 'name', 'OS/2']) assert(tables.has(tag), tag);
  const fvar = tables.get('fvar'), axes = new Map();
  for (let i = 0, offset = fvar.readUInt16BE(4); i < fvar.readUInt16BE(8); i++, offset += fvar.readUInt16BE(10)) axes.set(fvar.toString('latin1', offset, offset + 4), [fixed(fvar, offset + 4), fixed(fvar, offset + 8), fixed(fvar, offset + 12)]);
  assert.deepEqual(axes.get('wght'), [100, 400, 900]); assert.deepEqual(axes.get('opsz'), [14, 14, 32]);
  const gsub = layoutFeatures(tables.get('GSUB')), gpos = layoutFeatures(tables.get('GPOS'));
  for (const tag of ['calt', 'locl', 'tnum']) assert(gsub.has(tag), 'GSUB ' + tag);
  assert(gpos.has('kern'), 'GPOS kern');
  const points = cmapCodePoints(tables.get('cmap'));
  for (let c = 0x20; c <= 0x7e; c++) assert(points.has(c), 'Basic Latin U+' + c.toString(16));
  // Inter 4.1 has no glyph for the soft hyphen (U+00AD) or the deprecated ŉ (U+0149).
  for (let c = 0xa0; c <= 0x17f; c++) if (![0xad, 0x149].includes(c)) assert(points.has(c), 'Latin-1 / Latin Extended-A U+' + c.toString(16));
  // Spaces and punctuation that Intl date and number formatting produce, currency signs and UI arrows.
  for (const ch of '    –—‘’“”…•‹›‰€£¥₿₹−×÷±≈≤≥≠←↑→↓↗↘✓') assert(points.has(ch.codePointAt(0)), `U+${ch.codePointAt(0).toString(16)} ${ch}`);
  const license = await readFile(new URL('../public/fonts/Inter-LICENSE.txt', import.meta.url), 'utf8');
  assert.match(license, /SIL OPEN FONT LICENSE/i);
});

test('every character the site interface renders is in the Inter subset or never was in Inter', async () => {
  const points = cmapCodePoints(woff2Tables(await readFile(FONT)).get('cmap')), root = new URL('../public/', import.meta.url), missing = new Map();
  for (const name of (await readdir(root)).filter(name => /\.(html|m?js|css)$/.test(name) && !CATALOGUES.has(name))) {
    for (const ch of await readFile(new URL(name, root), 'utf8')) {
      const code = ch.codePointAt(0);
      if (code < 0x80 || /[\p{C}\p{Zl}\p{Zp}]/u.test(ch) || points.has(code) || INTER_LACKS.has(ch)) continue;
      (missing.get(ch) || missing.set(ch, new Set()).get(ch)).add(name);
    }
  }
  const report = [...missing].map(([ch, files]) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} ${ch} (${[...files].slice(0, 3).join(', ')})`);
  assert.deepEqual(report, [], 'Characters missing from public/fonts/InterVariable.woff2. If Inter 4.1 has a glyph, re-subset the full font:\n'
    + `pyftsubset InterVariable.woff2 --flavor=woff2 --layout-features=${FEATURES} --name-IDs='*' --name-languages='*' --notdef-outline --output-file=public/fonts/InterVariable.woff2 --unicodes=${ranges(new Set([...points, ...[...missing.keys()].map(ch => ch.codePointAt(0))]))}\n`
    + 'otherwise add the character to INTER_LACKS in this test.');
});
