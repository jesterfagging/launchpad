import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createAccountApp } from '../src/account-app.mjs';

async function fixture(t){
  const accounts={master:Buffer.alloc(32),getSession:async()=>null,registry:async()=>({accounts:[]}),hostStore:{read:async()=>null}};
  const server=createAccountApp({accounts,runtimes:{},policy:{},publicUrl:'https://launch.example',launchpad:{},marketData:{},funding:{},protocolFees:{},protocolTreasury:{},protocolGasFunding:{},branding:{},adminPanel:{},adminRevenue:{},explore:{},trading:{},adminVolume:{},lifetimeVolume:{},publicAnalytics:{read:async()=>({version:1})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.closeServices();});
  return (path,{method='GET',headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:'launch.example','x-forwarded-proto':'https',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);req.end();
  });
}

test('static delivery negotiates smaller lossless bytes with separate ETags and correct revalidation',async t=>{
  const get=await fixture(t),original=await readFile(new URL('../public/admin.js',import.meta.url));
  const plain=await get('/admin.js');assert.deepEqual(plain.bytes,original);assert.equal(plain.headers.vary,'Accept-Encoding');
  const br=await get('/admin.js',{headers:{'accept-encoding':'gzip,br'}});
  assert.equal(br.status,200);assert.equal(br.headers['content-encoding'],'br');assert.deepEqual(brotliDecompressSync(br.bytes),original);
  assert.equal(Number(br.headers['content-length']),br.bytes.length);assert.notEqual(br.headers.etag,plain.headers.etag);assert(br.bytes.length<plain.bytes.length/2);
  assert.match(br.headers['content-security-policy'],/default-src 'self'/);assert.match(br.headers['cache-control'],/must-revalidate/);
  const cached=await get('/admin.js',{headers:{'accept-encoding':'br','if-none-match':'W/'+br.headers.etag}});
  assert.equal(cached.status,304);assert.equal(cached.bytes.length,0);assert.equal(cached.headers.vary,'Accept-Encoding');assert.equal(cached.headers.etag,br.headers.etag);
  const wrong=await get('/admin.js',{headers:{'accept-encoding':'br','if-none-match':plain.headers.etag}});assert.equal(wrong.status,200);
  const gz=await get('/admin.js',{headers:{'accept-encoding':'br;q=0,gzip;q=1'}});assert.equal(gz.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(gz.bytes),original);
  assert.equal((await get('/admin.js',{headers:{'accept-encoding':'*;q=0'}})).status,406);
});
test('binary HEAD, private module gates and dynamic JSON retain existing behavior',async t=>{
  const get=await fixture(t),image=await get('/brand-icon.png',{headers:{'accept-encoding':'br,gzip'}}),head=await get('/brand-icon.png',{method:'HEAD',headers:{'accept-encoding':'br,gzip'}});
  assert.equal(image.status,200);assert.equal(image.headers['content-encoding'],undefined);assert.equal(image.headers.vary,undefined,'one body for every client: nothing to vary on');
  assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(head.headers['content-length'],image.headers['content-length']);assert.equal(head.headers.vary,undefined);
  // Release media: a day of reuse plus ETag revalidation without its content hash, immutable with it.
  const media='public, max-age=86400, stale-while-revalidate=604800',version=createHash('sha256').update(image.bytes).digest('hex').slice(0,16);
  assert.equal(image.headers['cache-control'],media);assert.equal(head.headers['cache-control'],media);
  assert.equal((await get('/brand-icon.png?v='+version)).headers['cache-control'],'public, max-age=31536000, immutable');
  for(const path of ['/brand-icon.svg?v=54','/gotchi/fomogotchi-head.png','/fonts/InterVariable.woff2'])assert.equal((await get(path)).headers['cache-control'],media,path);
  const revalidated=await get('/brand-icon.png',{headers:{'if-none-match':image.headers.etag}});assert.equal(revalidated.status,304);assert.equal(revalidated.headers['cache-control'],media);
  const privateModule=await get('/admin-pump-test-ui.mjs',{headers:{'accept-encoding':'br,gzip'}});assert.equal(privateModule.status,401);assert.equal(privateModule.headers['content-encoding'],undefined);
  const api=await get('/api/analytics',{headers:{'accept-encoding':'br,gzip'}});assert.equal(api.status,200);assert.equal(api.headers['content-encoding'],undefined);assert.deepEqual(JSON.parse(api.bytes),{version:1});
});

test('public account, explore, coin and navigation module graphs are served as JavaScript without authentication',async t=>{
  const get=await fixture(t),pending=['/explore.js','/coin.js','/creator.js','/wallet-account.js','/signin-overlay.mjs','/account-overlay.mjs','/navigation.mjs'],seen=new Set();
  while(pending.length){
    const path=pending.shift();if(seen.has(path))continue;seen.add(path);
    const result=await get(path);assert.equal(result.status,200,path);assert.match(result.headers['content-type'],/javascript/,path);
    const source=result.bytes.toString('utf8');
    for(const match of source.matchAll(/\bimport\s+(?:[^;'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)){
      assert.match(match[1],/^(?:\.\.?\/|\/)/,'Unbundled browser import in '+path);
      const dependency=new URL(match[1],'https://launch.example'+path);assert.equal(dependency.origin,'https://launch.example');pending.push(dependency.pathname);
    }
  }
  assert(seen.has('/launch-image.mjs'),'Profile fallback dependency must be served');
  assert(seen.has('/profile-image.mjs'));assert(seen.has('/launchpad-wallet.mjs'));
  t.diagnostic(`${seen.size} public JavaScript modules served successfully through the actual HTTP router.`);
});

test('pages carry a hash-allowed import map; only current content hashes are cached immutably',async t=>{
  const get=await fixture(t),policy="default-src 'self'; script-src 'self'; style-src 'self' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='; connect-src 'self'; img-src 'self' data:; frame-src https://dexscreener.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  // A top-level document load (the font preload Link header is sent only for these).
  const navigation={'sec-fetch-dest':'document','sec-fetch-mode':'navigate','sec-fetch-site':'none'};
  const page=await get('/',{headers:{'accept-encoding':'br',...navigation}}),html=brotliDecompressSync(page.bytes).toString();
  const text=/<meta charset="utf-8"><script type="importmap">([^<]*)<\/script>/.exec(html)[1],map=JSON.parse(text).imports;
  assert.equal(html.indexOf('<script type="importmap">'),html.indexOf('<script'),'the import map precedes every other script');
  const hash="'sha256-"+createHash('sha256').update(text).digest('base64')+"'";
  assert.equal(page.headers['content-security-policy'],policy.replace("script-src 'self';",`script-src 'self' ${hash};`));
  assert.equal(page.headers['cache-control'],'public, max-age=0, must-revalidate');
  const unchanged=await get('/',{headers:{'accept-encoding':'br','if-none-match':page.headers.etag,...navigation}});
  assert.equal(unchanged.status,304);assert.equal(unchanged.headers['content-security-policy'],page.headers['content-security-policy']);
  // Entry script, modulepreload hints and import-map targets are byte-identical URLs.
  assert(html.includes(`<script type="module" src="${map['/explore.js']}">`));
  const preloads=[...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(match=>match[1]);
  assert(preloads.includes(map['/navigation.mjs']));for(const href of preloads)assert(Object.values(map).includes(href),href);
  for(const path of ['/admin-damm-pump-test-ui.mjs','/admin-damm-pump-ui.mjs','/admin-meteora-ui.mjs','/admin-pump-public-ui.mjs','/admin-pump-test-ui.mjs','/pump-launch-test-ui.mjs','/admin-pump-deployment-ui.mjs'])assert.equal(map[path],undefined,path);
  assert.match(map['/vendor/solana-transaction.mjs'],/^\/vendor\/solana-transaction\.mjs\?v=[0-9a-f]{16}$/);
  const current=await get(map['/navigation.mjs']);
  assert.equal(current.status,200);assert.equal(current.headers['cache-control'],'public, max-age=31536000, immutable');assert.equal(current.headers['content-security-policy'],policy);
  assert.deepEqual(current.bytes,await readFile(new URL('../public/navigation.mjs',import.meta.url)));
  for(const path of ['/navigation.mjs','/navigation.mjs?v=0000000000000000','/navigation.mjs?v=53','/?v='+map['/explore.js'].split('=')[1]])assert.equal((await get(path)).headers['cache-control'],'public, max-age=0, must-revalidate',path);
  const font=/<link rel="preload" href="(\/fonts\/InterVariable\.woff2\?v=[0-9a-f]{16})"/.exec(html)[1],theme=/href="(\/curve-theme\.css\?v=[0-9a-f]{16})"/.exec(html)[1];
  assert((await get(theme)).bytes.toString().includes(`url('${font}')`),'@font-face and the preload name one URL');
  const woff=await get(font);assert.equal(woff.headers['cache-control'],'public, max-age=31536000, immutable');assert.equal(woff.headers.vary,undefined);assert.equal(woff.headers['content-type'],'font/woff2');
  // The page announces its font with a Link header naming that identical URL; nothing else is announced.
  assert.equal(page.headers.link,`<${font}>; rel=preload; as=font; type=font/woff2; crossorigin`);assert.equal(unchanged.headers.link,page.headers.link);
  // The router's background fetch() of a page template must not start a second font download.
  for(const headers of [{'sec-fetch-dest':'empty','sec-fetch-mode':'cors','sec-fetch-site':'same-origin',accept:'text/html'},{}]){const template=await get('/launchpad',{headers});assert.equal(template.status,200);assert.equal(template.headers.link,undefined,JSON.stringify(headers));}
  assert.equal(page.headers.vary,'Accept-Encoding');assert.equal(current.headers.vary,'Accept-Encoding');assert.equal(current.headers.link,undefined);
  // Pages whose scripts spell a stylesheet URL with their own `?v=` keep that spelling, so nothing loads twice.
  assert(html.includes('<link id="explore-search-styles" rel="stylesheet" href="/explore-search.css?v=50">'),'explore-search.css adopts the explore-search.mjs spelling');
  assert(html.includes('href="/quote-logos.css?v=52"')&&html.includes('src="/brand-icon.svg?v=54"'),'pinned spellings are kept');
  assert.equal((await get('/explore-search.css?v=50')).headers['cache-control'],'public, max-age=0, must-revalidate');
  const api=await get('/api/analytics');assert.equal(api.headers['cache-control'],'no-store');assert.equal(api.headers['content-security-policy'],policy);
});

test('v71.43: pages are served as a host without Robinhood Chain unless LAUNCHPAD_ROBINHOOD_ENABLED=1; its APIs answer 404',async t=>{
  const get=await fixture(t),raw=await readFile(new URL('../public/launchpad.html',import.meta.url),'utf8');
  assert.match(raw,/<body\b[^>]*\bdata-robinhood="on"/,'the file ships "on"; the host decides');
  for(const path of ['/','/launchpad','/admin','/docs']){const html=(await get(path)).bytes.toString();assert.match(html,/<body\b[^>]*\bdata-robinhood="off"/,path);assert.doesNotMatch(html,/data-robinhood="on"/,path);}
  for(const path of ['/api/launchpad/robinhood/status','/api/launchpad/robinhood/pairs','/api/admin/robinhood'])assert.equal((await get(path)).status,404,path);
  assert.equal((await get('/api/session')).status,200,'other launchpad APIs are untouched');
});
