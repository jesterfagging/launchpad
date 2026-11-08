import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { METEORA_EXTRA_ASSETS } from '../public/meteora-extra-assets.mjs';
import { QUOTE_LOGO_PATHS } from '../public/quote-logo-paths.mjs';
import { createQuoteIcon, createQuoteLabel, quoteLogoPath } from '../public/quote-logos.mjs';
import { createExploreCard } from '../public/explore-view.mjs';

const asset = symbol => LAUNCH_ASSETS.find(row => row.symbol === symbol);
const page = () => parseHTML('<html><head></head><body></body></html>').document;

test('current quotes use exact-mint bundled images or recorded unavailable-artwork fallbacks', async () => {
  const refresh=JSON.parse(await readFile(new URL('./fixtures/unavailable-quote-logos.json',import.meta.url),'utf8'));
  const unavailable=new Set(refresh.unavailableLogos.map(row=>row.mint));
  const catalog = [...new Map([...LAUNCH_ASSETS, ...METEORA_EXTRA_ASSETS.filter(row => row.logoPath)].map(row => [row.mint, row])).values()];
  assert.equal(Object.keys(QUOTE_LOGO_PATHS).length, catalog.length-unavailable.size);
  const paths = new Set();
  for (const row of catalog) {
    const path = quoteLogoPath(row.mint);
    if(unavailable.has(row.mint)){assert.equal(path,null);continue;}
    assert(path, row.symbol + ' logo missing');
    assert.match(path, new RegExp('^/quote-logos/' + row.mint + '\\.(png|jpg|webp)$'));
    assert(!paths.has(path), 'mint variants must not alias another mint path');paths.add(path);
    await access(new URL('../public' + path, import.meta.url));
  }
  for (const unsafe of ['__proto__','SOL','https://evil.invalid/logo.png','../../secret',asset('SOL').mint + '?other=1']) assert.equal(quoteLogoPath(unsafe), null);
});

test('unverified ticker aliases cannot borrow another asset logo or request a remote image', () => {
  const document = page(), known = asset('USDC'), spoofed = { mint: '11111111111111111111111111111111', symbol: 'USDC', image: 'https://evil.invalid/pixel' };
  const unknown = createQuoteLabel(document, spoofed);
  assert.equal(unknown.textContent, 'USDC');assert.equal(unknown.querySelector('img'), null);
  const real = createQuoteLabel(document, { ...known, symbol: 'FAKE', image: 'https://evil.invalid/pixel' });
  assert.equal(real.textContent, 'USDC');assert.equal(real.querySelector('img').src, quoteLogoPath(known.mint));
  const variants = LAUNCH_ASSETS.filter(row => /^MSTR/i.test(row.symbol));
  assert(variants.length >= 2);assert.equal(new Set(variants.map(row => quoteLogoPath(row.mint))).size, variants.length);
});

test('icons preserve layout and accessible labels when image loading succeeds or fails', () => {
  const document = page(), row = LAUNCH_ASSETS.find(row => row.mint === '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'), icon = createQuoteIcon(document, row, { size:44 }), image = icon.querySelector('img');
  assert.equal(icon.getAttribute('aria-hidden'), 'true');assert.equal(image.alt, '');assert.equal(image.width, 44);assert.equal(image.height, 44);
  assert.equal(image.loading, 'lazy');assert.equal(image.decoding, 'async');assert.equal(icon.dataset.state, 'loading');
  image.onload();assert.equal(icon.dataset.state, 'ready');image.onerror();assert.equal(icon.dataset.state, 'fallback');assert.equal(icon.querySelector('img'), null);assert.equal(icon.textContent, 'WBTC');assert.equal(icon.dataset.size, '44');
  const label = createQuoteLabel(document, row);assert.equal(label.textContent, 'WBTC');assert.match(label.title, /Wrapped Bitcoin.*Wormhole/);
  label.querySelector('img').onerror();assert.equal(label.textContent, 'WBTC');assert.equal(label.querySelector('img'), null);
  assert.equal(document.querySelectorAll('#curve-quote-logo-styles').length, 1);
});

test('Explore and profile cards retain coin artwork and link while adding the paired asset logo', () => {
  const document = page(), quote = asset('BONK'), coin = { mint: asset('SOL').mint, name:'Example', symbol:'EXAMPLE', image:'/token-images/' + 'a'.repeat(64) + '.png', quote };
  const card = createExploreCard(document, coin);
  assert.equal(card.href, '/coin?mint=' + coin.mint);assert.equal(card.querySelector('.explore-coin-image>img').src, coin.image);
  const pair = card.querySelector('.explore-coin-pair');assert.equal(pair.textContent, 'BONK');assert.equal(pair.getAttribute('aria-label'), 'Paired with BONK');assert.equal(pair.querySelector('img').src, quoteLogoPath(quote.mint));
});

test('custom catalog logos use only published content-hash paths and cannot override bundled mint logos',()=>{
  const document=page(),mint='11111111111111111111111111111111',logoPath='/token-images/'+'a'.repeat(64)+'.webp';
  const custom={category:'custom',mint,name:'Custom Pair',symbol:'PAIR',logoPath};
  const icon=createQuoteIcon(document,custom,{size:44});assert.equal(icon.querySelector('img').src,logoPath);assert.equal(icon.dataset.size,'44');assert.equal(createQuoteLabel(document,custom).querySelector('img').src,logoPath);
  for(const logoPath of ['https://evil.invalid/pixel','data:image/png;base64,AA==','/token-images/../secret','/token-images/'+'a'.repeat(64)+'.svg','/token-images/'+'a'.repeat(64)+'.png?x=1'])assert.equal(createQuoteIcon(document,{...custom,logoPath}).querySelector('img'),null);
  assert.equal(createQuoteIcon(document,{...custom,category:'crypto'}).querySelector('img'),null);assert.equal(createQuoteIcon(document,{...custom,mint:'unsafe'}).querySelector('img'),null);
  const known=asset('SOL');assert.equal(createQuoteIcon(document,{...custom,mint:known.mint}).querySelector('img').src,quoteLogoPath(known.mint));
  icon.querySelector('img').onerror();assert.equal(icon.dataset.state,'fallback');assert.equal(icon.textContent,'PAIR');
});

test('origin badges require verified metadata and never infer provenance from ticker, issuer or mint suffix',async()=>{
  const {createQuoteOriginBadge}=await import('../public/quote-logos.mjs'),document=page(),mint='123456789ABCDEFGHJKLMNPQRSTUVWXYZpump';
  const base={mint,name:'Custom asset',symbol:'PUMP',category:'custom',issuer:'Pump.fun',logoPath:'/token-images/'+'a'.repeat(64)+'.png'};
  for(const fields of [{},{launchpadOrigin:'pump'},{originVerified:true},{launchpadOrigin:'pump',originVerified:'true'},{launchpadOrigin:'unknown',originVerified:true},{launchpadOrigin:'__proto__',originVerified:true},{launchpadOrigin:'https://evil.invalid/logo',originVerified:true},{launchpadOrigin:'pump',originVerified:true,category:'stocks'},{launchpadOrigin:'pump',originVerified:true,mint:'invalid'}])assert.equal(createQuoteOriginBadge(document,{...base,...fields}),null);
  for(const [origin,caption] of [['pump','Pump.fun'],['stonk','Stonk']]){
    const data={...base,launchpadOrigin:origin,originVerified:true},label=createQuoteLabel(document,data,{icon:false,origin:true,strong:true}),badge=label.querySelector('.quote-origin-badge'),img=badge.querySelector('img');
    assert.equal(label.textContent,'PUMP');assert.equal(label.querySelector('.quote-logo'),null);assert.equal(label.querySelector('strong').textContent,'PUMP');assert.equal(badge.dataset.origin,origin);assert.equal(badge.getAttribute('role'),'img');assert.equal(badge.getAttribute('aria-label'),'Launched on '+caption);assert.match(label.title,new RegExp('Launched on '+caption.replace('.','\\.')));assert.equal(img.src,'/pair-origin-'+origin+'.png');assert.equal(img.width,14);assert.equal(img.height,14);assert.equal(img.alt,'');
    img.onerror();assert.equal(badge.dataset.state,'missing');assert.equal(badge.querySelector('img'),img,'reserved badge dimensions remain on failed image load');
    assert.equal(createQuoteIcon(document,data,{size:44}).querySelector('img').src,base.logoPath,'origin never replaces token artwork');
  }
});
test('logo styles use the current version for new and existing page shells',()=>{
  const document=page();createQuoteIcon(document,asset('SOL'));assert.equal(document.querySelector('#curve-quote-logo-styles').getAttribute('href'),'/quote-logos.css?v=52');document.querySelector('#curve-quote-logo-styles').href='/quote-logos.css?v=49';createQuoteLabel(document,asset('SOL'));assert.equal(document.querySelector('#curve-quote-logo-styles').getAttribute('href'),'/quote-logos.css?v=52');assert.equal(document.querySelectorAll('#curve-quote-logo-styles').length,1);
});
