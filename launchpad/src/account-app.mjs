import { launchpadEnv } from './brand-env.mjs';
import { MAX_WALLETS, MAX_STORED_WALLETS } from '../public/wallet-limits.mjs';
import { QUOTE_LOGO_PATHS } from '../public/quote-logo-paths.mjs';
import { requireLive } from './live-settings.mjs';
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, open } from 'node:fs/promises';
import { atomicWrite } from './telegram-store.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseWallet, invariant } from './core.mjs';
import { cashbackSummary } from './account-policy.mjs';
import { isIP } from 'node:net';
import { settingsSecrets } from './account-secrets.mjs';
import { AccountConnections } from './account-connections.mjs';
import { robinhoodApi } from './robinhood-api.mjs';
import { SessionDiagnostics, monitorAllowed, publicStatus } from './session-diagnostics.mjs';
import { AccountMarketData } from './market-data.mjs';
import { Launchpad } from './launchpad.mjs';
import { PumpTestService } from './pump-test-service.mjs';
import { PumpFundedTestService } from './pump-funded-test-service.mjs';
import { PumpDeploymentService } from './pump-deployment-service.mjs';
import { createDammPumpIntegration } from './damm-pump-app.mjs';
import { dammPumpRevenueAnalyticsSources } from './damm-pump-revenue.mjs';
import { DammPumpFeeDeploymentService } from './damm-pump-fee-deployment-service.mjs';
import { createDammPumpTestIntegration, createDammPumpTestMetadataPublisher } from './damm-pump-test-app.mjs';
import { DammPumpTestDeploymentService } from './damm-pump-test-deployment-service.mjs';
import { PumpPublicService } from './pump-public-service.mjs';
import { createMeteoraIntegration } from './meteora-app.mjs';
import { meteoraHookProgramId, meteoraHookApps } from './meteora-service.mjs';
import { PumpPublicClientAdapter } from './pump-public-adapter.mjs';
import { PumpPublicDeploymentService } from './pump-public-deployment-service.mjs';
import { assertRaydiumLaunchRequest } from './launch-destination.mjs';
import { LaunchCustomPairs } from './launchpad-custom-pairs.mjs';
import { LaunchFeeAssignments } from './launchpad-fee-assignments.mjs';
import { PersonalRewards } from './personal-rewards.mjs';
import { MAX_LAUNCH_IMAGE } from './launchpad-media.mjs';
import { LaunchpadAdmin } from './launchpad-admin.mjs';
import { LaunchpadExplore } from './launchpad-explore.mjs';
import { LaunchpadTrading } from './launchpad-trading.mjs';
import { AdminPanel } from './admin-panel.mjs';
import { AdminFailedLaunchArchive } from './admin-failed-launch-archive.mjs';
import { AdminCleanup } from './admin-cleanup.mjs';
import { AdminBurnHistory } from './admin-burn-history.mjs';
import { LaunchChain } from './launchpad-chain.mjs';
import { VanityMintPool } from './vanity-pool.mjs';
import { PublicKey } from '@solana/web3.js';
import { createStaticSite, staticAssetRepresentation, staticAssetMatches, staticAssetVaries, staticCacheControl, withScriptHashes, STATIC_MEDIA } from './static-assets.mjs';
import { AdminRevenue } from './admin-revenue.mjs';
import { AdminRevenueAudit } from './admin-revenue-audit.mjs';
import { HolderRewardDiagnostics } from './holder-reward-diagnostics.mjs';
import { AdminVolume } from './admin-volume.mjs';
import { PublicAnalytics } from './public-analytics.mjs';
import { PersistentLifetimeVolume } from './public-lifetime-volume.mjs';
import { PublicPoolVolumeHistory } from './public-pool-volume-history.mjs';
import { PublicBurnSupply } from './public-burn-supply.mjs';
import { units as launchUnits } from '../public/launchpad-model.mjs';
import { LaunchProtocolFees, launchProtocolPolicy } from './launchpad-protocol-fees.mjs';
import { ProtocolTreasury } from './protocol-treasury.mjs';
import { ProtocolGasFunding } from './protocol-gas-funding.mjs';
import { ProtocolTreasuryChain } from './protocol-treasury-chain.mjs';
import { LaunchBranding } from './launchpad-branding.mjs';
import { FundingService } from './funding.mjs';
import { HostHealth } from './host-health.mjs';
import { operatorCapacity } from './operator-capacity.mjs';
import { productFeatures, launchpadApi, launchpadAccount, robinhoodEnabled } from './product-mode.mjs';
import { tenantConfig, platformShare, brandFile } from './tenant/config.mjs';
import { createBrandSkin } from './brand.mjs';
import { createTenantSkin, recolouredFile as tenantRecoloured, tokenFile as tenantTokenFile, markSvg } from './tenant/skin.mjs';
import { createPadFeatures, setActivePad } from './tenant/pad.mjs';
import { TenantTreasury } from './tenant/treasury.mjs';
import { chatCompletion as openrouterChat } from './agent/openrouter.mjs';
import { GotchiService } from './gotchi-service.mjs';
import { GotchiChain } from './gotchi-chain.mjs';
import { GOTCHI_THEMES } from '../public/gotchi-catalog.mjs';
import { AgentService, agentConfig } from './agent/service.mjs';
import { handleXRoutes } from './agent/x-http.mjs';
import { handleInfluencerRoutes } from './agent/influencer-http.mjs';
import { AgentChain } from './agent/chain.mjs';
import { PumpClassicService, pumpClassicConfig } from './pump-classic/service.mjs';
import { PumpClassicChain } from './pump-classic/chain.mjs';
import { RobinhoodLaunchService, robinhoodLaunchConfig } from './robinhood-launch/service.mjs';

// A coin's published metadata file: a Solana mint (base58) or an EVM token address (0x…, any case).
const TOKEN_METADATA_PATH=/^\/token-metadata\/(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})\.json$/;
// A Robinhood pair's badge, served by the host from its logo cache or the operator's override (src/robinhood-launch/logos.mjs).
const PAIR_LOGO_PREFIX='/robinhood-pairs/logo/', PAIR_LOGO_PATH=/^\/robinhood-pairs\/logo\/0x[0-9a-fA-F]{40}$/;
const dammTransientCodes=new Set(['DAMM_VENUE_RPC','DAMM_RPC_BUSY','DAMM_WALLET_GUARD_RPC','SOL_ROUTE_RATE_LIMITED','SOL_ROUTE_PROVIDER_UNAVAILABLE','SOL_ROUTE_NETWORK','SOL_ROUTE_TIMEOUT','SOL_ROUTE_NOT_FOUND']);
const dammRequestPath=path=>/^\/api\/(?:launchpad\/damm-pump|admin\/damm-pump(?:-test)?)\//.test(path);
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map(Object.entries({ '/sniper-settings.mjs': ['sniper-settings.mjs', 'text/javascript'], '/liquidity-plans.mjs': ['liquidity-plans.mjs', 'text/javascript'], '/wallet-limits.mjs': ['wallet-limits.mjs', 'text/javascript'], '/': ['index.html', 'text/html'], '/run-settings.mjs': ['run-settings.mjs', 'text/javascript'], '/run-ui.js': ['run-ui.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/trading-ui.js': ['trading-ui.js', 'text/javascript'], '/account-ui.js': ['account-ui.js', 'text/javascript'], '/account-security-ui.js': ['account-security-ui.js', 'text/javascript'], '/portfolio-ui.js': ['portfolio-ui.js', 'text/javascript'], '/strategy-settings.mjs': ['strategy-settings.mjs', 'text/javascript'], '/presets.mjs': ['presets.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.ico': ['favicon.ico', 'image/x-icon'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] }));
assets.set('/curve-theme.css',['curve-theme.css','text/css']);
assets.set('/curve-motion.css',['curve-motion.css','text/css']);assets.set('/curve-motion.mjs',['curve-motion.mjs','text/javascript']);
const brandMedia=new Set(['/brand-icon.svg','/brand-logo.svg','/brand-icon.png','/brand-avatar.png','/brand-avatar.jpg']);
for(const path of brandMedia)assets.set(path,[path.slice(1),path.endsWith('.svg')?'image/svg+xml':path.endsWith('.jpg')?'image/jpeg':'image/png']);
// Only release-bundled, mint-specific files are served. Request paths never
// select arbitrary files or a remote logo URL.
const binaryAssets = new Set(brandMedia);
for(const [mint,path] of Object.entries(QUOTE_LOGO_PATHS)){
  invariant(typeof path==='string'&&path.startsWith('/quote-logos/'+mint+'.')&&/^\/quote-logos\/[1-9A-HJ-NP-Za-km-z]{32,44}\.(png|jpg|webp)$/.test(path),'Invalid bundled quote logo path.');
  assets.set(path,[path.slice(1),path.endsWith('.jpg')?'image/jpeg':path.endsWith('.webp')?'image/webp':'image/png']);binaryAssets.add(path);
}
for(const name of ['quote-logos.mjs','quote-logo-paths.mjs','quote-logos.css','coin-image.mjs','amm-branding.mjs','amm-branding.css','coin-creator-earnings.mjs','coin-creator-earnings.css'])assets.set('/'+name,[name,name.endsWith('.css')?'text/css':'text/javascript']);
for(const name of ['quote-display-identity.mjs','quote-display-assets.mjs'])assets.set('/'+name,[name,'text/javascript']);
assets.set('/fonts/InterVariable.woff2',['fonts/InterVariable.woff2','font/woff2']);binaryAssets.add('/fonts/InterVariable.woff2');
assets.set('/fonts/Inter-LICENSE.txt',['fonts/Inter-LICENSE.txt','text/plain']);
// v71.43 identity: Bricolage Grotesque (display) and Geist Mono (numbers), self-hosted under the OFL like Inter.
for(const name of ['BricolageGrotesque-Bold.woff','BricolageGrotesque-Regular.woff','GeistMono-Regular.woff','GeistMono-Bold.woff']){assets.set('/fonts/'+name,['fonts/'+name,'font/woff']);binaryAssets.add('/fonts/'+name);}
for(const name of ['BricolageGrotesque-LICENSE.txt','GeistMono-LICENSE.txt'])assets.set('/fonts/'+name,['fonts/'+name,'text/plain']);
// Fredoka (UI, variable 300-700) and Lilita One (display), both OFL and self-hosted: launchpad font choices.
for(const name of ['Fredoka.woff2','LilitaOne.woff2']){assets.set('/fonts/'+name,['fonts/'+name,'font/woff2']);binaryAssets.add('/fonts/'+name);}
for(const name of ['Fredoka-LICENSE.txt','LilitaOne-LICENSE.txt'])assets.set('/fonts/'+name,['fonts/'+name,'text/plain']);
const errorText = error => String(error?.message || 'Request failed.').replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 300);
for (const [url, name, mime] of [['/tutorial','tutorial.html','text/html'],['/tutorial.css','tutorial.css','text/css'],['/robinhood','robinhood.html','text/html'],['/robinhood-ui.js','robinhood-ui.js','text/javascript'],['/robinhood.css','robinhood.css','text/css'],['/chains.mjs','chains.mjs','text/javascript'],['/solana-chain.svg','solana-chain.svg','image/svg+xml'],['/robinhood-chain.svg','robinhood-chain.svg','image/svg+xml']]) assets.set(url, [name, mime]);
for (const [url, name, type] of [['/terminal.css','terminal.css','text/css'],['/terminal-ui.js','terminal-ui.js','text/javascript'],['/sessions','sessions.html','text/html'],['/sessions-ui.js','sessions-ui.js','text/javascript']]) assets.set(url, [name,type]);
for (const name of ['lightweight-charts.mjs','lightweight-charts-LICENSE.txt','lightweight-charts-NOTICE.txt']) assets.set(`/vendor/${name}`, [`vendor/${name}`,name.endsWith('.mjs') ? 'text/javascript' : 'text/plain']);
assets.set('/market-chart.js',['market-chart.js','text/javascript']);
assets.set('/dexscreener-view.mjs',['dexscreener-view.mjs','text/javascript']);
for(const name of ['coin-activity.mjs','holders-view.mjs','live-trades-view.mjs'])assets.set('/'+name,[name,'text/javascript']);
assets.set('/coin-trade.mjs',['coin-trade.mjs','text/javascript']);
assets.set('/coin-trade.css',['coin-trade.css','text/css']);
assets.set('/explore-search.mjs',['explore-search.mjs','text/javascript']);
assets.set('/explore-search.css',['explore-search.css','text/css']);
assets.set('/curve-price-badge.mjs',['curve-price-badge.mjs','text/javascript']);
assets.set('/curve-price-badge.css',['curve-price-badge.css','text/css']);
assets.set('/workspace.css',['workspace.css','text/css']);
for (const name of ['account-connections-ui.js','connection-fields.mjs','tool-layout-ui.js']) assets.set('/' + name, [name, 'text/javascript']);
for (const name of ['workspace-shell.js','ui-performance.mjs','execution-presets.mjs','execution-presets-ui.js']) assets.set('/' + name, [name, 'text/javascript']);
assets.set('/site-tape.mjs',['site-tape.mjs','text/javascript']);
assets.set('/dashboard.css',['dashboard.css','text/css']);
assets.set('/launchpad',['launchpad.html','text/html']);
assets.set('/wallet-account',['wallet-account.html','text/html']);
assets.set('/profile',['wallet-account.html','text/html']);
assets.set('/creator',['creator.html','text/html']);
assets.set('/creator.js',['creator.js','text/javascript']);
assets.set('/wallet-account.js',['wallet-account.js','text/javascript']);
assets.set('/signin-overlay.mjs',['signin-overlay.mjs','text/javascript']);
assets.set('/account-overlay.mjs',['account-overlay.mjs','text/javascript']);
assets.set('/cashback-wallet-ui.mjs',['cashback-wallet-ui.mjs','text/javascript']);
assets.set('/signin-wallet-ui.mjs',['signin-wallet-ui.mjs','text/javascript']);
assets.set('/evm-wallet-link-ui.mjs',['evm-wallet-link-ui.mjs','text/javascript']);
assets.set('/profile-image.mjs',['profile-image.mjs','text/javascript']);
assets.set('/launched-tokens',['launched-tokens.html','text/html']);
assets.set('/launched-tokens.js',['launched-tokens.js','text/javascript']);
assets.set('/launched-tokens.css',['launched-tokens.css','text/css']);
assets.set('/personal-earnings.mjs',['personal-earnings.mjs','text/javascript']);
assets.set('/launch-curve-chart.mjs',['launch-curve-chart.mjs','text/javascript']);
for(const name of ['launch-admin-ui.mjs','admin-protocol-ui.mjs','admin-branding-ui.mjs','creator-claims.mjs','creator-fee-schedule.mjs'])assets.set('/'+name,[name,'text/javascript']);
assets.set('/launch-admin.css',['launch-admin.css','text/css']);
for (const name of ['solana-transaction.mjs','solana-transaction-LICENSE.txt','solana-transaction-NOTICE.txt']) assets.set('/vendor/'+name,['vendor/'+name,name.endsWith('.mjs')?'text/javascript':'text/plain']);
for (const name of ['damm-pump-ui.mjs','damm-pump-trade-ui.mjs','pump-public-ui.mjs','pump-public-trade-ui.mjs','meteora-ui.mjs','meteora-trade-ui.mjs','meteora-account-ui.mjs','meteora-account.css','meteora-extra-assets.mjs','launchpad.js','basket-catalog.mjs','basket-ui.mjs','launch-image.mjs','launchpad-wallet.mjs','launchpad-model.mjs','paycheck-policy.mjs','launch-assets.mjs','quote-identity.mjs','launchpad.css']) assets.set('/'+name,[name,name.endsWith('.css')?'text/css':'text/javascript']);
assets.set('/funding',['funding.html','text/html']);
assets.set('/funding.js',['funding.js','text/javascript']);
assets.set('/',['explore.html','text/html']);
assets.set('/explore',['explore.html','text/html']);
assets.set('/trade',['index.html','text/html']);
assets.set('/coin',['coin.html','text/html']);
assets.set('/admin',['admin.html','text/html']);
// The site-styled 404 page for browser navigations. Its key is never routed as a
// page, so `/404` itself answers 404 like any other unknown address.
assets.set('/404',['not-found.html','text/html']);
const privatePumpModules = new Set(['/admin-damm-pump-test-ui.mjs','/admin-damm-pump-ui.mjs','/admin-meteora-ui.mjs','/admin-pump-public-ui.mjs','/admin-pump-test-ui.mjs','/pump-launch-test-ui.mjs','/admin-pump-deployment-ui.mjs']);
for (const path of privatePumpModules) assets.set(path,[path.slice(1),'text/javascript']);
for(const page of ['docs','terms','privacy','analytics'])assets.set('/'+page,[page+'.html','text/html']);
for(const name of ['analytics.js','analytics.css','analytics-view.mjs','analytics-dates.mjs','burn-valuation.mjs'])assets.set('/'+name,[name,name.endsWith('.css')?'text/css':'text/javascript']);
assets.set('/navigation.mjs',['navigation.mjs','text/javascript']);
assets.set('/navigation.css',['navigation.css','text/css']);
assets.set('/documentation.css',['documentation.css','text/css']);
assets.set('/documentation.js',['documentation.js','text/javascript']);
assets.set('/admin.js',['admin.js','text/javascript']);
assets.set('/admin-revenue-ui.mjs',['admin-revenue-ui.mjs','text/javascript']);
assets.set('/admin-revenue-audit-ui.mjs',['admin-revenue-audit-ui.mjs','text/javascript']);
assets.set('/admin-volume-ui.mjs',['admin-volume-ui.mjs','text/javascript']);
assets.set('/admin-treasury-ui.mjs',['admin-treasury-ui.mjs','text/javascript']);
assets.set('/admin-burn-history-ui.mjs',['admin-burn-history-ui.mjs','text/javascript']);
assets.set('/admin-gas-ui.mjs',['admin-gas-ui.mjs','text/javascript']);
assets.set('/admin-pairs-ui.mjs',['admin-pairs-ui.mjs','text/javascript']);
assets.set('/custom-pair-fields.mjs',['custom-pair-fields.mjs','text/javascript']);
assets.set('/pair-origin-pump.png',['pair-origin-pump.png','image/png']);
assets.set('/pair-origin-stonk.png',['pair-origin-stonk.png','image/png']);
assets.set('/admin-reward-diagnostics-ui.mjs',['admin-reward-diagnostics-ui.mjs','text/javascript']);
assets.set('/admin-health-ui.mjs',['admin-health-ui.mjs','text/javascript']);
assets.set('/admin.css',['admin.css','text/css']);
for(const name of ['explore.js','explore-view.mjs','coin.js','coin-view.mjs','coin-rewards-view.mjs','explore.css','coin.css','coin-rewards.css'])assets.set('/'+name,[name,name.endsWith('.css')?'text/css':'text/javascript']);
// Gotchi Mode: the public page, its shared catalogue/character modules and the
// release-bundled character layers. Only bundled files are ever served.
assets.set('/gotchi',['gotchi.html','text/html']);
for(const name of ['gotchi.js','gotchi-catalog.mjs','gotchi-character.mjs','gotchi.css','gotchi-character.css','admin-gotchi-ui.mjs'])assets.set('/'+name,[name,name.endsWith('.css')?'text/css':'text/javascript']);
for(const theme of GOTCHI_THEMES)for(const rig of theme.stages||[theme.rig])for(const layer of rig.layers){invariant(/^[a-z]+(?:-[a-z0-9]+){1,2}\.png$/.test(layer.file),'Invalid bundled Gotchi layer.');assets.set('/gotchi/'+layer.file,['gotchi/'+layer.file,'image/png']);binaryAssets.add('/gotchi/'+layer.file);}
// AI Agent mode: the Agents discovery page, the shared catalogue and the coin/launch/admin modules.
assets.set('/agents',['agents.html','text/html']);
for(const name of ['agents.js','agents.css','agent-catalog.mjs','agent-view.mjs','agent-fund.mjs','admin-agents-ui.mjs','influencer-catalog.mjs','influencer-ui.mjs','influencer-ui.css'])assets.set('/'+name,[name,name.endsWith('.css')?'text/css':'text/javascript']);
for(const name of ['pump-classic-catalog.mjs','pump-option-catalog.mjs','pump-classic-ui.mjs','pump-classic-coin.mjs','admin-pump-classic-ui.mjs','admin-vanity-ui.mjs','admin-cleanup-ui.mjs','admin-list-kit.mjs','robinhood-launch-catalog.mjs','robinhood-curve-math.mjs','robinhood-pool-math.mjs','robinhood-launch-ui.mjs','robinhood-coin.mjs','evm-wallet.mjs','admin-robinhood-ui.mjs','launch-chains.mjs'])assets.set('/'+name,[name,'text/javascript']);
// Transfer hook rules (v71.28): the shared catalogue, the Rules card / allowlist manager and its styles.
for(const name of ['hook-catalog.mjs','hook-ui.mjs','hook-ui.css'])assets.set('/'+name,[name,name.endsWith('.css')?'text/css':'text/javascript']);
// White-label launchpads (LAUNCHPAD_PRODUCT=tenant): the skin, the Rack layout, the shell and the shared catalogue. Every host serves
// the files; only a launchpad's pages use them (<body data-product="tenant">, src/tenant/skin.mjs).
// The platform's own name (LAUNCHPAD_BRAND_NAME, src/brand.mjs): the browser half keeps script-drawn words in it.
assets.set('/brand-shell.mjs',['brand-shell.mjs','text/javascript']);
// The platform token for the browser (public/platform-token.mjs): served with the host's LAUNCHPAD_TOKEN_MINT, or none.
assets.set('/platform-token.mjs',['platform-token.mjs','text/javascript']);
for(const name of ['tenant.css','tenant-rack.css','tenant-clean.css','tenant-arcade.css','tenant-look.css','tenant-shell.mjs','tenant-copy.mjs','tenant-catalog.mjs','tenant-pad.mjs','tenant-pad.css'])assets.set('/'+name,[name,name.endsWith('.css')?'text/css':'text/javascript']);
const TENANT = tenantConfig();
const tenantSkin = TENANT ? createTenantSkin(TENANT, { publicUrl: launchpadEnv('PUBLIC_URL') || '' }) : null;
const brandSkin = createBrandSkin();
// A launchpad has no engine analytics, tutorial or Robinhood page, and Gotchi / Agents pages only when it offers them.
const TENANT_OFF_PAGES = TENANT ? ['/analytics', '/tutorial', '/robinhood', ...(TENANT.modes.includes('gotchi') ? [] : ['/gotchi']), ...(TENANT.modes.includes('agent') ? [] : ['/agents'])] : [];
if(TENANT)for(const [url,name] of [['/docs','tenant-docs.html'],['/terms','tenant-terms.html'],['/privacy','tenant-privacy.html']])assets.set(url,[name,'text/html']);
// The launchpad's own feature pages (src/tenant/pad.mjs): one page, drawn by public/tenant-pad.mjs for the path.
if(TENANT)for(const [url,feature] of [['/launches','registry'],['/stats','registry'],['/summit','summit'],['/takeover','takeover']])if(TENANT.features?.[feature])assets.set(url,['tenant-pad.html','text/html']);
// Pages are served with an import map and `?v=<content hash>` URLs for their
// modules, styles and media; matching requests are cached immutably. Private
// administrator modules are excluded and keep their authenticated no-store path.
// v71.43: every page ships <body data-robinhood="on">; a host without LAUNCHPAD_ROBINHOOD_ENABLED=1 serves it as "off", which
// hides every Robinhood control (styles) and makes the pages behave Solana-only (scripts read the attribute).
const ROBINHOOD_MARK = /(<body\b[^>]*\bdata-robinhood=")on(")/;
const readPublic = async name => { const bytes = await readFile(join(publicRoot, name));
  // A white-label launchpad has no platform token; another host serves its own (src/brand.mjs).
  if (name === 'platform-token.mjs') return Buffer.from(TENANT ? createBrandSkin(undefined, { tokenMint: '' }).platformTokenModule(bytes.toString('utf8')) : brandSkin.platformTokenModule(bytes.toString('utf8')));
  // A launchpad: the engine's stylesheets in its preset, its token file with the palette, its pages in its name and shell.
  if (tenantSkin) { if (tenantRecoloured(name)) return Buffer.from(tenantSkin.recolourStylesheet(bytes.toString('utf8'))); if (tenantTokenFile(name)) return Buffer.from(bytes.toString('utf8') + tenantSkin.tokensCss()); if (!name.endsWith('.html')) return bytes; let page = bytes.toString('utf8'); if (!robinhoodEnabled()) page = page.replace(ROBINHOOD_MARK, '$1off$2'); return Buffer.from(tenantSkin.rebrandPage(page)); }
  if (!name.endsWith('.html')) return bytes; let text = bytes.toString('utf8'); if (!robinhoodEnabled()) text = text.replace(ROBINHOOD_MARK, '$1off$2'); return Buffer.from(brandSkin.rebrandPage(text)); };
const staticSite = createStaticSite({ assets, read: readPublic, exclude: privatePumpModules });
const NOT_FOUND_PAGE = '/404', AGENT_STREAMS_PER_VIEWER = 6;
// Exact built-in Lightweight Charts attribution CSS; no general inline-style permission.
const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='; connect-src 'self'; img-src 'self' data:; frame-src https://dexscreener.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const cookieToken = req => String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('launchpad-session='))?.slice('launchpad-session='.length) || '';
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v);
const launchMarketPath = path => path === '/api/launchpad/trades' || path === '/api/launchpad/market' || path.startsWith('/api/launchpad/market/');
const retiredProviderInstructions = value => typeof value === 'string' && /connections|api[ -]?key|helius key|trading runs|toolkit/i.test(value);
// Provider status text is not a request for users to configure infrastructure.
// Preserve market rows and timestamps, including unavailable/stale indicators.
function launchMarketView(value) {
  if(Array.isArray(value))return value.map(launchMarketView);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='connectionRequired').map(([key,item])=>{
    if(['note','warning','error','source','historyNote'].includes(key)&&typeof item==='string'){
      if(retiredProviderInstructions(item))return[key,key==='historyNote'?'Recent wallet swap history is temporarily unavailable.':'Market data is temporarily unavailable. Try refreshing shortly.'];
      if(key==='source'&&item==='Your Solana RPC')return[key,'Solana onchain'];
    }
    return[key,launchMarketView(item)];
  }));
}


// Fixed-window request limits with a bounded table. A full table never refuses
// a new caller (that turned one flood into a site-wide 429): it forgets expired
// windows, then the least recently used window that is not currently refusing
// requests, and only as a last resort the least recently used window overall.
// Every refusal carries the remaining wait (Retry-After).
export class RateLimits {
  constructor({ maxBuckets = 50000, now = Date.now } = {}) { this.buckets = new Map(); this.nextCleanup = 0; this.maxBuckets = maxBuckets; this.now = now; }
  refused(bucket, now) { return Object.assign(new Error('Too many attempts. Try again shortly.'), { statusCode: 429, retryAfterMs: Math.max(1000, bucket.until - now), rateWindow: true }); }
  check(key, limit, windowMs = 60000) {
    const now = this.now();
    if (now >= this.nextCleanup) { for (const [k, v] of this.buckets) if (v.until <= now) this.buckets.delete(k); this.nextCleanup = now + 1000; }
    let bucket = this.buckets.get(key);
    if (bucket && bucket.until <= now) { this.buckets.delete(key); bucket = undefined; }
    // Re-inserting keeps the map in least-recently-used order.
    if (bucket) this.buckets.delete(key);
    else {
      if (this.buckets.size >= this.maxBuckets) {
        let victim, scanned = 0;
        for (const [candidate, value] of this.buckets) { if (value.count < value.limit) { victim = candidate; break; } if (++scanned >= 256) break; }
        this.buckets.delete(victim ?? this.buckets.keys().next().value);
      }
      bucket = { count: 0, until: now + windowMs, limit };
    }
    this.buckets.set(key, bucket);
    if (++bucket.count > limit) throw this.refused(bucket, now);
  }
  // Refuses when the window is already used up, without counting this request.
  peek(key, limit) {
    const now = this.now(), bucket = this.buckets.get(key);
    if (bucket && bucket.until > now && bucket.count >= limit) throw this.refused(bucket, now);
  }
}
async function bodyJson(req, {maxBytes = 262144, sizeMessage = 'Input too large.'} = {}) {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type']))) throw Object.assign(new Error('Expected JSON.'), { statusCode: 415 });
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > maxBytes) throw Object.assign(new Error(sizeMessage), { statusCode: 413 }); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); invariant(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.'); return value; }
  catch { throw new Error('Invalid JSON input.'); }
}

export function createAccountApp({ accounts, runtimes, policy, robinhood = null, publicUrl = '', maxUsers = 1000, marketData = null, launchpad = null, funding = null, explore = null, trading = null, adminPanel = null, protocolFees = null, protocolTreasury = null, protocolGasFunding = null, branding = null, adminRevenue = null, adminRevenueAudit = null, adminVolume = null, publicAnalytics = null, lifetimeVolume = null, adminBurnHistory = null, publicBurnSupply = null, pumpTest = null, pumpFundedTest = null, pumpDeployment = null, pumpPublic = null, pumpPublicDeployment = null, dammPump = null, dammPumpDeployment = null, dammPumpTest = null, dammPumpTestDeployment = null, meteora = null, vanityPool = null, features = productFeatures() }) {
  features = Object.freeze({ toolkit: features?.toolkit === true, telegram: features?.toolkit === true && features?.telegram === true, walletOnly: features?.walletOnly !== false, robinhood: features?.robinhood === true });
  const configured = publicUrl ? new URL(publicUrl) : null, limits = new RateLimits(), streams = new Map(), agentStreams = new Map(), agentStreamViewers = new Map();
  const health = new HostHealth(), staticWarm = new AbortController(); let stopping = false, readiness = null, readinessAt = 0;
  const csrfSession = async (token, csrf) => accounts.getSessionWithCsrf ? accounts.getSessionWithCsrf(token, csrf) : { session: await accounts.getSession(token), csrfValid: await accounts.verifyCsrf(token, csrf) };
  const asset = name => staticSite.asset(name);
  const connections = new AccountConnections(accounts, runtimes, robinhood?.runtimes);
  // Launchpad reads use the operator's Solana runtime settings and public data
  // defaults. Do not read or revive saved CoinGecko/Blockscout connections.
  const marketConnections = features.toolkit ? connections : {
    market: { readSettings: async () => ({ settings: { coingeckoKey: '', coingeckoPlan: 'demo', blockscoutKey: '', marketRefreshSeconds: '60' }, revision: 'launchpad-public-v1' }) },
    solana: { rpcGate: runtimes.rpcGate, readSettings: id => runtimes.readSettings(id) },
  };
  const marketFeeds = marketData || new AccountMarketData(marketConnections);
  const diagnostics = features.toolkit ? new SessionDiagnostics(accounts, runtimes, robinhood?.runtimes) : null;
  const launches = launchpad || new Launchpad(accounts,runtimes,{publicUrl,walletOnly:features.walletOnly});
  const pairCatalogue=launches.customPairs ||= new LaunchCustomPairs({accounts,launchpad:launches});
  const pumpLab = pumpTest || new PumpTestService({accounts});
  // Owner-only features refuse other administrators with 403 and code OWNER_ONLY,
  // so the admin panel can tell "owner feature" apart from lost admin access.
  const ownerOnly = async session => {
    try { return await pumpLab.requireOwner(session); }
    catch (error) {
      if (error?.statusCode === 403 && session?.account?.role === 'admin' && !session.account.banned && monitorAllowed(session)) { try { error.code ||= 'OWNER_ONLY'; } catch { /* frozen errors keep their own shape */ } }
      throw error;
    }
  };
  const pumpFunded = pumpFundedTest || new PumpFundedTestService({accounts,requireOwner:session=>ownerOnly(session)});
  let ownerDeployment = pumpDeployment;
  const pumpDeploymentService = () => ownerDeployment || (ownerDeployment = new PumpDeploymentService({accounts,requireOwner:session=>ownerOnly(session)}));
  // Vanity contract addresses: one encrypted pool of operator-supplied mint keys
  // shared by every launch venue. Before an address is handed out it is checked
  // onchain (an address that already holds an account can never become a mint).
  const vanity = vanityPool || new VanityMintPool({accounts,onChain:async addresses=>{
    const chain=new LaunchChain({network:'mainnet-beta',rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',rpcGate:runtimes.rpcGate,rpcScope:'vanity'});
    try{const found=[];for(let i=0;i<addresses.length;i+=100){const infos=await chain.c.getMultipleAccountsInfo(addresses.slice(i,i+100).map(a=>new PublicKey(a)),'confirmed');found.push(...infos.map(info=>!!info));}return found;}
    finally{chain.close?.();}
  }});
  launches.vanity ||= vanity;
  const launchAdmin = new LaunchpadAdmin({launchpad:launches,accounts});
  const failedLaunchArchive = new AdminFailedLaunchArchive({accounts,launchpad:launches,launchAdmin});
  const cleanupAdmin = new AdminCleanup({accounts,launchpad:launches,launchAdmin});
  const feeAssignments = new LaunchFeeAssignments({launchpad:launches,accounts});
  const protocolRevenue = protocolFees || new LaunchProtocolFees({accounts,launchpad:launches});
  const treasuryChainFactory=async({operatorId})=>{
    const {settings}=await runtimes.readSettings(operatorId);
    const rpcUrl=launchpadEnv('PUBLIC_RPC_URL')||settings.rpcUrl||(settings.heliusKey?`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(settings.heliusKey)}`:undefined);
    const chain=new ProtocolTreasuryChain({network:'mainnet-beta',rpcUrl,rpcGate:runtimes.rpcGate,rpcScope:'protocol-treasury',rpcRequestsPerSecond:settings.rpcRequestsPerSecond,jupiterKey:settings.jupiterKey||'',burnMints:[]});
    try{return await chain.init();}catch(error){chain.close?.();throw error;}
  };
  // A launchpad's treasury (src/tenant/treasury.mjs) reads the chain through the host's own RPC settings, not an administrator's:
  // it runs as the system from the first start.
  const tenantChainFactory=async()=>{const chain=new ProtocolTreasuryChain({network:'mainnet-beta',rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||undefined,rpcGate:runtimes.rpcGate,rpcScope:'protocol-treasury',jupiterKey:launchpadEnv('PUBLIC_JUPITER_KEY')||'',burnMints:[]});try{return await chain.init();}catch(error){chain.close?.();throw error;}};
  const treasury = protocolTreasury || (TENANT
    ? new TenantTreasury({accounts,launchpad:launches,chainFactory:tenantChainFactory,share:platformShare()})
    : new ProtocolTreasury({accounts,launchpad:launches,chainFactory:treasuryChainFactory}));
  const gasFunding = protocolGasFunding || new ProtocolGasFunding({accounts,launchpad:launches,chainFactory:async({operatorId})=>{
    const {settings}=await runtimes.readSettings(operatorId);
    const rpcUrl=launchpadEnv('PUBLIC_RPC_URL')||settings.rpcUrl||(settings.heliusKey?`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(settings.heliusKey)}`:undefined);
    const chain=new ProtocolTreasuryChain({network:'mainnet-beta',rpcUrl,rpcGate:runtimes.rpcGate,rpcScope:'protocol-gas-funding',rpcRequestsPerSecond:settings.rpcRequestsPerSecond,jupiterKey:settings.jupiterKey||''});
    try{return await chain.init();}catch(error){chain.close?.();throw error;}
  }});
  const revenueReport = adminRevenue || new AdminRevenue({accounts,launchpad:launches,toolkit:features.toolkit});
  const revenueAudit = adminRevenueAudit || new AdminRevenueAudit({accounts,launchpad:launches});
  const rewardDiagnostics = new HolderRewardDiagnostics({accounts});
  const platformBranding = branding || new LaunchBranding({accounts,launchpad:launches});
  const operator = adminPanel || new AdminPanel({accounts,launchpad:launches,launchAdmin,policy,robinhoodPolicy:robinhood?.policy,protocolFees:protocolRevenue,toolkit:features.toolkit});
  const discovery = explore || new LaunchpadExplore({accounts,rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',rpcGate:runtimes.rpcGate});
  // A launchpad's own features (registry, Summit, ticker lock, bundle check, takeovers), each switched on by its owner.
  const PAD = TENANT && Object.values(TENANT.features || {}).some(Boolean) ? createPadFeatures({ config: TENANT, discovery, dir: accounts.dir, rpcUrl: launchpadEnv('PUBLIC_RPC_URL') || '', host: (launchpadEnv('PUBLIC_URL') || '').replace(/^https?:\/\//, '').replace(/\/$/, ''), log: line => console.log(line) }) : null;
  if (PAD) { setActivePad(PAD); PAD.start(); }
  // Gotchi vaults are server-managed signers; the adapter reuses the public RPC
  // and Jupiter settings and is created per worker pass, like the treasury.
  const gotchi = new GotchiService({accounts,launchpad:launches,discovery,requireOwner:session=>ownerOnly(session),chainFactory:async()=>{
    const chain=new GotchiChain({network:'mainnet-beta',rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',rpcGate:runtimes.rpcGate,rpcScope:'gotchi',jupiterKey:launchpadEnv('PUBLIC_JUPITER_KEY')||''});
    try{return await chain.init();}catch(error){chain.close?.();throw error;}
  }});
  launches.gotchiTarget=id=>gotchi.launchTarget(id);
  // AI Agent mode: one durable core (SQLite ledger) that provisions agent
  // wallets, ingests finalized fee receipts and drives the isolated worker.
  // Disabled hosts answer 503 on its routes and never spawn anything.
  const agents = new AgentService({accounts,launchpad:launches,discovery,requireOwner:session=>ownerOnly(session),config:agentConfig(),protocolRecipient:async()=>(await launchProtocolPolicy(accounts)).recipient||null,chainFactory:async()=>{
    const chain=new AgentChain({network:'mainnet-beta',rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',rpcGate:runtimes.rpcGate,rpcScope:'agents',jupiterKey:launchpadEnv('PUBLIC_JUPITER_KEY')||''});
    try{return await chain.init();}catch(error){chain.close?.();throw error;}
  }});
  launches.agentTarget=(request,options)=>agents.launchTarget(request,options);
  // An address an AI Agent is bound to (an agent draft named it) is never handed out again: the agent ledger allows one agent per mint.
  // When the ledger cannot be opened the pool fails closed and Admin shows the check warning.
  vanity.inUse ||= async address=>{if(!agents.available())return false;const store=agents.agentStore||await agents.ensure();return !!store.agentByMint(address);};
  const publicPump = pumpPublic || new PumpPublicService({accounts, adapter:new PumpPublicClientAdapter({rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',rpcGate:runtimes.rpcGate}), requireOwner: session => ownerOnly(session),
    getCreationFee: async () => {const policy=await launchProtocolPolicy(accounts);return {lamports:launchUnits(policy.creationFeeSol||'0',9).toString(),recipient:policy.recipient};},
    getSolUsdPrice: async () => {
      const chain = await discovery.chain(), mint = 'So11111111111111111111111111111111111111112';
      return chain.referencePrice({quoteMint:mint}, await chain.mintInfo(mint));
    },
    // `replace` is passed only for a vanity address leased to this launch and not yet used: a file left
    // by an earlier attempt that gave the address back must not keep the address from being used.
    publishMetadata: async ({accountId,mint,name,symbol,description,image,website,twitter,telegram,replace=false}) => {
      invariant(configured?.protocol === 'https:', 'Configure the public HTTPS address before launching.');
      invariant(typeof mint === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || /^0x[0-9a-fA-F]{40}$/.test(mint)), 'Invalid token mint.');
      invariant(typeof image === 'string' && /^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(image), 'Upload a token image before reviewing your launch.');
      await launches.ownedImage(accountId, image.split('/').at(-1));
      const evm=/^0x/.test(mint), coinUrl=configured.origin+'/coin?mint='+mint+(evm?'&chain=robinhood':'');
      const metadata = {name,symbol,description,image:configured.origin+image,external_url:coinUrl,
        // An EVM coin's `contractURI()` / `tokenURI()` JSON (ERC-7572 / ERC-1046) is read by explorers and aggregators that look
        // for the flat keys; the Solana shape (`extensions`) is kept for both so one reader works everywhere.
        ...(evm?{external_link:coinUrl,website:website||coinUrl,...(twitter?{twitter}:{}),...(telegram?{telegram}:{})}:{}),
        extensions:{website:website||coinUrl,...(twitter?{twitter}:{}),...(telegram?{telegram}:{})},properties:{files:[{uri:configured.origin+image,type:image.endsWith('.png')?'image/png':image.endsWith('.jpg')?'image/jpeg':'image/webp'}],category:'image'}};
      const folder=join(accounts.dir,'token-metadata'), file=join(folder,mint+'.json'), encoded=JSON.stringify(metadata);
      await mkdir(folder,{recursive:true});
      let saved;try{saved=await readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
      invariant(saved===undefined||saved===encoded||replace===true,'This mint already has different published metadata.');
      if(saved!==encoded){await atomicWrite(file,encoded);const directory=await open(folder,'r');try{await directory.sync();}finally{await directory.close();}}
      return configured.origin+'/token-metadata/'+mint+'.json';
    },
  });
  // Pump.fun Classic: native Pump.fun launches with per-coin Launchpad wallets. One
  // SQLite journal; disabled hosts answer 503 and never start the worker.
  const pumpClassicChainFactory=async()=>{const chain=new PumpClassicChain({network:'mainnet-beta',rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',rpcGate:runtimes.rpcGate,rpcScope:'pump-classic',jupiterKey:launchpadEnv('PUBLIC_JUPITER_KEY')||''});
  // Pump coins the host admits as quote assets beyond Pump's own list (LAUNCHPAD_PUMP_COIN_QUOTES, comma-separated mints).
  chain.pumpCoinQuotes=(launchpadEnv('PUMP_COIN_QUOTES')||'').split(',').map(value=>value.trim()).filter(Boolean);try{return await chain.init();}catch(error){chain.close?.();throw error;}};
  const pumpClassic = new PumpClassicService({accounts,launchpad:launches,vanity,rebroadcast:{everyMs:2000,times:15},requireOwner:session=>ownerOnly(session),config:pumpClassicConfig(),publishMetadata:publicPump.publishMetadata,
    gotchiTarget:id=>gotchi.launchTarget(id),agentTarget:(request,options)=>agents.launchTarget(request,options),
    protocolRecipient:async()=>(await launchProtocolPolicy(accounts)).recipient||null,
    chainFactory:pumpClassicChainFactory});
  gotchi.pumpClassic = pumpClassic; agents.pumpClassic = pumpClassic; discovery.pumpClassic = pumpClassic; launchAdmin.pumpClassic = pumpClassic;
  treasury.pumpClassicSources = () => pumpClassic.treasurySources();
  revenueReport.pumpClassicRevenueSources = () => pumpClassic.revenueSources();
  // v71.39 Robinhood Chain: Launchpad's own launch contracts (contracts/curve-launch-evm), per-coin EVM wallets in the host
  // store, one SQLite journal. Disabled hosts answer 503 and never start the worker.
  const robinhoodLaunch = new RobinhoodLaunchService({accounts,requireOwner:session=>ownerOnly(session),config:robinhoodLaunchConfig(),publishMetadata:publicPump.publishMetadata});
  discovery.robinhoodLaunch = robinhoodLaunch; launchAdmin.robinhoodLaunch = robinhoodLaunch;
  revenueReport.robinhoodRevenueSources = () => robinhoodLaunch.revenueSources();
  treasury.agentShareSources = () => agents.protocolShareSources();
  revenueReport.agentShareRevenueSources = async () => ({ complete: true, sources: await agents.protocolShareSources() });
  const dammPumpIntegration=dammPump?null:createDammPumpIntegration({accounts,launches,discovery,requireOwner:session=>ownerOnly(session),publishMetadata:publicPump.publishMetadata,rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',rpcGate:runtimes.rpcGate});
  const dammPumpLaunches=dammPump||dammPumpIntegration.service;
  discovery.dammPump=dammPumpLaunches;launchAdmin.dammPump=dammPumpLaunches;
  if(typeof dammPumpLaunches.load==='function')revenueReport.dammPumpRevenueSources=async()=>dammPumpRevenueAnalyticsSources(await dammPumpLaunches.load());
  let dammDeployment=dammPumpDeployment;
  const dammDeploymentService=()=>dammDeployment||=new DammPumpFeeDeploymentService({accounts,requireOwner:session=>ownerOnly(session),ensureRelayer:()=>dammPumpLaunches.ensureRelayer(),installDeployment:config=>dammPumpLaunches.installDeployment(config),deploymentConfig:()=>dammPumpLaunches.deploymentConfig(),rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'https://api.mainnet-beta.solana.com'});
  const dammPumpTestIntegration=dammPumpTest?null:createDammPumpTestIntegration({accounts,productionService:dammPumpLaunches,requireOwner:session=>ownerOnly(session),publishMetadata:createDammPumpTestMetadataPublisher({accounts,launches,publicUrl}),rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',rpcGate:runtimes.rpcGate});
  const dammPumpTestLaunches=dammPumpTest||dammPumpTestIntegration.service;
  let dammTestDeployment=dammPumpTestDeployment;
  const dammTestDeploymentService=()=>dammTestDeployment||=new DammPumpTestDeploymentService({accounts,requireOwner:session=>ownerOnly(session),ensureRelayer:()=>dammPumpTestLaunches.ensureRelayer(),installDeployment:config=>dammPumpTestLaunches.installDeployment(config),deploymentConfig:()=>dammPumpTestLaunches.deploymentConfig(),rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'https://api.mainnet-beta.solana.com'});
  const meteoraIntegration = meteora ? null : createMeteoraIntegration({accounts, launches, discovery,
    requireOwner:session=>ownerOnly(session), publishMetadata:publicPump.publishMetadata,
    rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'', rpcGate:runtimes.rpcGate, gotchiTarget:id=>gotchi.launchTarget(id), agentTarget:(request,options)=>agents.launchTarget(request,options)});
  const meteoraLaunches = meteora || meteoraIntegration.service;
  meteoraLaunches.vanity ||= vanity;
  // Transfer hook rules (v71.28): on only when the owner has deployed the hook program and names it in LAUNCHPAD_HOOK_PROGRAM_ID.
  if (meteoraLaunches.hookProgramId === undefined || meteoraLaunches.hookProgramId === null) meteoraLaunches.hookProgramId = meteoraHookProgramId(launchpadEnv('HOOK_PROGRAM_ID'));
  // App-only rules (v71.36): FOMO-only and Pump App-only are offered only when the owner names each app's mark in
  // LAUNCHPAD_HOOK_FOMO_MARK / LAUNCHPAD_HOOK_PUMP_APP_MARK (signer:<wallet>, program:<id> or program:<id>:account:<slot>; no built-in
  // address; the hook program must carry rule kinds 26 and 27 of v71.36).
  if (!meteoraLaunches.hookApps || Object.values(meteoraLaunches.hookApps).every(v => !v)) meteoraLaunches.hookApps = meteoraHookApps({ fomo: launchpadEnv('HOOK_FOMO_MARK'), pumpApp: launchpadEnv('HOOK_PUMP_APP_MARK') });
  gotchi.meteora = meteoraLaunches;
  agents.meteora = meteoraLaunches;
  protocolRevenue.meteora = meteoraLaunches;
  discovery.meteora = meteoraLaunches;
  launchAdmin.meteora = meteoraLaunches;
  treasury.meteoraSources = revenueReport.meteoraSources = revenueAudit.meteoraSources = () => meteoraLaunches.treasurySources();
  if(typeof meteoraLaunches.analyticsRevenueSources==='function')revenueReport.meteoraRevenueSources=()=>meteoraLaunches.analyticsRevenueSources();
  discovery.pumpPublic = publicPump;
  launchAdmin.pumpPublic = publicPump;
  let publicDeployment = pumpPublicDeployment;
  const publicDeploymentService = () => publicDeployment ||= new PumpPublicDeploymentService({accounts,requireOwner:session=>ownerOnly(session),ensureRelayer:()=>publicPump.ensureRelayer(),installDeployment:config=>publicPump.installDeployment(config),deploymentConfig:()=>publicPump.deploymentConfig(),rpcUrl:launchpadEnv('PUMP_PUBLIC_RPC_URL')||launchpadEnv('PUBLIC_RPC_URL')||'https://api.mainnet-beta.solana.com'});
  const volumeReport = adminVolume || new AdminVolume({accounts,explore:discovery});
  rewardDiagnostics.additionalRecords = () => meteoraLaunches.analyticsRewardRecords();
  rewardDiagnostics.pricesByMint = () => volumeReport.quotePrices();
  const personalRewards = new PersonalRewards({accounts,launchpad:launches,prices:()=>{
    const prices=new Map(volumeReport.quotePrices?.() || []);
    for(const [mint,reference] of discovery.quoteReferences || [])if(!reference.mint||reference.mint===mint){const previous=prices.get(mint);if(!previous||reference.at>previous.at)prices.set(mint,reference);}
    return prices;
  }});
  const lifetimeReport = lifetimeVolume || new PersistentLifetimeVolume({store:accounts.hostStore,pumpTrades:mint=>publicPump.analyticsTrades(mint),dammPumpTrades:mint=>dammPumpLaunches.analyticsTrades(mint),meteoraTrades:mint=>meteoraLaunches.analyticsTrades(mint),pumpClassicTrades:mint=>pumpClassic.trades(mint),
    poolHistory:new PublicPoolVolumeHistory({store:accounts.hostStore,inventory:async()=>{await volumeReport.inventory();return {records:volumeReport.records,sources:volumeReport.sources,complete:volumeReport.inventoryComplete};}}),
    inventory:async()=>{await volumeReport.inventory();return {records:volumeReport.records,complete:volumeReport.inventoryComplete};},
    quotePrices:()=>{void volumeReport.refreshQuotePrices?.({background:true});return volumeReport.quotePrices();},
  });
  volumeReport.lifetime = lifetimeReport;
  const burnHistory = adminBurnHistory || new AdminBurnHistory({accounts,connectionFactory:async({actorId})=>{
    const {settings}=await runtimes.readSettings(actorId);
    const rpcUrl=launchpadEnv('PUBLIC_RPC_URL')||settings.rpcUrl||(settings.heliusKey?`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(settings.heliusKey)}`:undefined);
    const chain=new LaunchChain({network:'mainnet-beta',rpcUrl,rpcGate:runtimes.rpcGate,rpcScope:'admin-burn-history',rpcRequestsPerSecond:settings.rpcRequestsPerSecond});
    try { await chain.init(); return {connection:chain.c,close:()=>chain.close?.()}; }
    catch(error) { chain.close?.(); throw error; }
  }});
  const burnSupplyReport = publicBurnSupply || new PublicBurnSupply({connectionFactory:async()=>{
    // Reuse the verified mainnet connection and shared RPC gate. This reader
    // owns no wallets and cannot submit transactions or alter receipt ledgers.
    const chain=await discovery.chain();
    return {connection:{getAccountInfoAndContext:(mint,options)=>chain.withRpcContext(
      {deadline:Date.now()+2500},()=>chain.c.getAccountInfoAndContext(mint,options))}};
  }});
  const analyticsReport = publicAnalytics || new PublicAnalytics({accounts,volume:volumeReport,lifetime:lifetimeReport,revenue:revenueReport,burnHistory,burnSupply:burnSupplyReport});
  // Launchpad trades use operator infrastructure. Browser requests cannot
  // select a provider, inject keys, or borrow a user's toolkit configuration.
  let tokenTrading = trading;
  const tradingService = () => tokenTrading ||= new LaunchpadTrading({accounts,explore:discovery,rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',jupiterKey:launchpadEnv('PUBLIC_JUPITER_KEY')||'',rpcGate:runtimes.rpcGate,walletOnly:features.walletOnly});
  const fundingService = features.toolkit ? funding || new FundingService(accounts,runtimes,robinhood?.runtimes) : null;
  const protect = (id, result) => ({ ...result, settings: settingsSecrets(accounts.master, id, result.settings).protectedSettings });
  const resolve = async (id, raw) => settingsSecrets(accounts.master, id, (await runtimes.readSettings(id)).settings).resolve(raw);
  const requireAdmin = session => {
    if (session?.account?.role !== 'admin') throw Object.assign(Error('Administrator access required.'), { statusCode: 403 });
    if (!monitorAllowed(session)) throw Object.assign(new Error('Enable two-factor authentication in Account → Security before using administration.'), { statusCode: 403 });
  };
  if (configured) invariant(configured.protocol === 'https:' && !configured.username && !configured.password && configured.pathname === '/' && !configured.search && !configured.hash, 'LAUNCHPAD_PUBLIC_URL must be an HTTPS origin, for example https://launch.example.com.');
  const server = http.createServer(async (req, res) => {
    let observedPath = '';
    const finish = health.begin(); res.once('finish', () => finish(res.statusCode, observedPath)); res.once('close', () => finish(res.writableFinished ? res.statusCode : 0, observedPath));
    const host = req.headers.host, port = server.address()?.port;
    const origin = configured?.origin || `http://${host}`;
    const allowedHosts = configured ? new Set([configured.host]) : new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    for (const [key, value] of Object.entries({
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': contentSecurityPolicy,
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...(configured ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    })) res.setHeader(key, value);
    const send = (code, value) => {
      if (res.writableEnded || res.destroyed) return;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.account || observedPath === '/api/session') value = { ...value, features };
        if (!features.toolkit) {
          if (value.account) value = { ...value, account: launchpadAccount(value.account) };
          if (Array.isArray(value.accounts)) value = { ...value, accounts: value.accounts.map(launchpadAccount) };
        }
      }
      if(launchMarketPath(observedPath))value=launchMarketView(value);
      health.observe(observedPath, code, value); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(json(value));
    };
    const setCookie = (value, seconds) => res.setHeader('set-cookie', `launchpad-session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${configured ? '; Secure' : ''}`);
    try {
      if (!allowedHosts.has(host)) return send(403, { error: 'Use the configured Launchpad address.' });
      const peer = req.socket.remoteAddress || '', loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
      // Public mode accepts HTTPS terminated by the local reverse proxy only.
      // Forwarded headers from arbitrary remote peers are never trusted.
      if (configured && (!loopback || req.headers['x-forwarded-proto'] !== 'https')) return send(403, { error: 'Use the HTTPS Launchpad website.' });
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
      const ip = configured && loopback && isIP(forwarded) ? forwarded : peer || 'unknown';
      const url = new URL(req.url, origin), path = url.pathname;
      const userPage = /^\/user\/([a-z0-9_][a-z0-9_-]{2,31})\/?$/i.exec(path);
      const pageAsset = userPage ? assets.get('/creator') : path === NOT_FOUND_PAGE || TENANT_OFF_PAGES.includes(path) ? undefined : assets.get(path);
      observedPath = path;
      // HEAD answers like GET without a body (uptime checks, link checkers).
      const read = req.method === 'GET' || req.method === 'HEAD';
      // A top-level document load (not fetch(), prefetch or a module/style request).
      const documentRequest = req.headers['sec-fetch-dest'] === 'document' || req.headers['sec-fetch-mode'] === 'navigate';
      // Browser navigations to an unknown page get the site's 404 page; scripts and /api/* keep JSON.
      const notFound = async (error = 'Not found.') => {
        if (read && !path.startsWith('/api/') && /\btext\/html\b/i.test(String(req.headers.accept || ''))) {
          let item = null, value = null;
          try { item = await asset(assets.get(NOT_FOUND_PAGE)[0]); value = await staticAssetRepresentation(item, 'text/html', req.headers['accept-encoding']); } catch { value = null; }
          if (value) {
            res.setHeader('vary', 'Accept-Encoding');
            if (item.scriptHashes?.length) res.setHeader('content-security-policy', withScriptHashes(contentSecurityPolicy, item.scriptHashes));
            if (item.linkHeader && documentRequest) res.setHeader('link', item.linkHeader);
            if (value.encoding) res.setHeader('content-encoding', value.encoding);
            res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': value.bytes.length });
            res.end(req.method === 'HEAD' ? undefined : value.bytes); return;
          }
        }
        return send(404, { error });
      };
      const publicMedia=(req.method==='GET'||req.method==='HEAD'&&(brandMedia.has(path)||TENANT&&path.startsWith('/brand/')))&&(brandMedia.has(path)||TENANT&&/^\/brand\/[a-z0-9.-]{1,40}$/.test(path)||/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(path)||TOKEN_METADATA_PATH.test(path)||PAIR_LOGO_PATH.test(path));
      // Public HTML files are static shells; account and trading data use the
      // separately protected APIs. Permit ordinary links into these pages only.
      // The X OAuth callback (v71.30) is a browser navigation arriving from x.com; it carries no session on that
      // first hop (SameSite=Strict) and src/agent/x-http.mjs re-requests it from our own origin before acting.
      const publicNavigation = req.method === 'GET' && (pageAsset?.[1] === 'text/html' || path === '/api/launchpad/x/callback')
        && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
        && ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
      if(publicMedia)res.setHeader('access-control-allow-origin','*');
      if (!publicMedia && req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Cross-origin request refused.' });
      if (!publicMedia && !publicNavigation && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return send(403, { error: 'Cross-site request refused.' });
      if(read&&(userPage||path==='/creator')){
        const username=(userPage?.[1]||url.searchParams.get('username')||'').trim().toLowerCase();
        if(/^[a-z0-9_][a-z0-9_-]{2,31}$/.test(username)){
          const canonical='/user/'+encodeURIComponent(username);
          if(path!==canonical){res.writeHead(308,{location:canonical});res.end();return;}
        }
      }
      if(read&&path.startsWith('/user/')&&!userPage)return notFound('Creator not found.');
      // A hosting platform's view of a launchpad it runs (LAUNCHPAD_TENANT_STATUS_KEY): a shared key from the environment, never
      // a session. Block /api/internal/ at the reverse proxy as well (docs/WHITE-LABEL.md); the key is the second lock.
      if (TENANT && path === '/api/internal/launchpad') {
        const key = String(launchpadEnv('TENANT_STATUS_KEY') || ''), given = String(req.headers['x-launchpad-key'] || '');
        if (req.method !== 'GET' || key.length < 32 || given.length !== key.length || !timingSafeEqual(Buffer.from(given), Buffer.from(key))) return send(404, { error: 'Not found.' });
        let coins = null; try { coins = (await discovery.inventory()).size; } catch { coins = null; }
        let accountsCount = null; try { accountsCount = (await accounts.list()).length; } catch { accountsCount = null; }
        return send(200, { name: TENANT.name, slug: TENANT.slug, publicUrl: configured?.origin || '', venues: TENANT.venues, modes: TENANT.modes, coins, accounts: accountsCount, treasury: await treasury.platformSummary?.() ?? null, at: Date.now() });
      }
      if (!features.toolkit && path.startsWith('/api/') && !launchpadApi(path)) return send(404, { error: 'Not found.' });
      if (!features.telegram && ['/api/account/telegram-link','/api/account/telegram-unlink'].includes(path)) return send(404, { error: 'Not found.' });
      if (features.walletOnly && path === '/api/account/register') return send(403, { error: 'Connect your wallet to create your Launchpad account.' });
      if (!features.toolkit && read && (['/trade','/robinhood','/sessions','/funding','/tutorial','/connections'].includes(path) || path === '/' && ['tool','token','connections','chain'].some(key=>url.searchParams.has(key)))) {
        const mint = url.searchParams.get('token'), accountLink = url.searchParams.has('account') || url.searchParams.has('connections');
        const location = accountLink ? '/?account=overview' : mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? '/coin?mint='+encodeURIComponent(mint) : '/';
        res.writeHead(303, { location }); res.end(); return;
      }
      if (read && path === '/healthz') return send(stopping ? 503 : 200, { ok: !stopping });
      if (read && path === '/readyz') {
        limits.check(`readiness:${ip}`, 30);
        if (!readiness || Date.now() - readinessAt > 5000) {
          readinessAt = Date.now(); readiness = Promise.resolve().then(() => accounts.registry()).then(() => true, () => false);
        }
        const ready = !stopping && await readiness;
        return send(ready ? 200 : 503, { ready });
      }
      // A launchpad's brand art (brand/ next to tenant.json): the logo, the icons, and the fallback mark. The
      // engine's own logo files answer with the launchpad's mark, so no page or old link ever shows another brand.
      if (TENANT && read && (path.startsWith('/brand/') || brandMedia.has(path))) {
        const name = path.startsWith('/brand/') ? path.slice(7) : brandFile('icon-180.png') ? 'icon-180.png' : 'mark.svg';
        if (name === 'mark.svg' || !TENANT.logo && Object.hasOwn({ 'logo-512.png': 1, 'icon-64.png': 1, 'icon-180.png': 1 }, name)) { const body = Buffer.from(markSvg(TENANT)); res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600', 'content-length': body.length }); res.end(req.method === 'HEAD' ? undefined : body); return; }
        const file = brandFile(name); if (!file) return notFound('Not found.');
        try { const body = await readFile(file); res.writeHead(200, { 'content-type': name.endsWith('.jpg') ? 'image/jpeg' : 'image/png', 'cache-control': 'public, max-age=3600', 'content-length': body.length }); res.end(req.method === 'HEAD' ? undefined : body); return; } catch { return notFound('Not found.'); }
      }
      if (req.method === 'GET' && /^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(path)) {
        try {const image=await launches.image(path.split('/').at(-1));res.writeHead(200,{'content-type':image.type,'cache-control':'public, max-age=31536000, immutable','access-control-allow-origin':'*'});res.end(image.bytes);return;} catch {return send(404,{error:'Token image not found.'});}
      }
      if (req.method === 'GET' && PAIR_LOGO_PATH.test(path)) {
        // A Robinhood pair's badge (v71.40): the operator's override file, else the published logo the host cached. Public media, a day in caches.
        limits.check(`robinhood-logo:${ip}`,600);
        let logo=null; try {logo=await robinhoodLaunch.pairLogo(path.slice(PAIR_LOGO_PREFIX.length));} catch {logo=null;}
        if(!logo)return send(404,{error:'No logo for this pair.'});
        if(staticAssetMatches(req.headers['if-none-match'],logo.etag)){res.writeHead(304,{etag:logo.etag,'cache-control':STATIC_MEDIA});res.end();return;}
        res.writeHead(200,{'content-type':logo.type,'content-length':logo.bytes.length,'cache-control':STATIC_MEDIA,etag:logo.etag,'access-control-allow-origin':'*','x-content-type-options':'nosniff'});res.end(logo.bytes);return;
      }
      if (privatePumpModules.has(path)) {
        if (req.method !== 'GET') return send(405,{error:'Method not allowed.'});
        const privateToken=cookieToken(req), privateSession=privateToken?await accounts.getSession(privateToken):null;
        if (!privateSession) return send(401,{error:'Sign in to continue.'});
        requireAdmin(privateSession); await ownerOnly(privateSession);
        const value=await asset(pageAsset[0]);
        const current=await accounts.getSession(privateToken);
        if (!current || current.account.id!==privateSession.account.id) return send(403,{error:'Session changed. Sign in again.'});
        requireAdmin(current); await ownerOnly(current);
        res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, no-store','vary':'Cookie','content-length':value.bytes.length});
        res.end(value.bytes); return;
      }
      if (read && pageAsset) {
        // Preserve bookmarked trading and account links from before Explore became home.
        const legacyTrade=features.toolkit&&path==='/'&&['tool','token','account','connections','chain'].some(key=>url.searchParams.has(key));
        const [name, type] = legacyTrade?assets.get('/trade'):pageAsset;
        const item = await asset(name), value = await staticAssetRepresentation(item,type,req.headers['accept-encoding']);
        // Encoding is negotiated for text only; fonts and raster images are one body for every client.
        if(staticAssetVaries(type))res.setHeader('vary','Accept-Encoding');
        if(!value){res.writeHead(406,{'content-length':0});res.end();return;}
        // Pages carry one inline import map; only its exact hash is allowed.
        if(item.scriptHashes?.length)res.setHeader('content-security-policy',withScriptHashes(contentSecurityPolicy,item.scriptHashes));
        // The page's font preload, repeated as a Link header so the fetch starts with the response headers.
        // Only for a document load: on the router's background fetch() of a page the header would start
        // a second, uncredentialed download of the same font.
        if(item.linkHeader&&documentRequest)res.setHeader('link',item.linkHeader);
        // `?v=` equal to the content hash never changes meaning; HTML always revalidates.
        res.setHeader('etag', value.etag); res.setHeader('cache-control', staticCacheControl(item,type,url.searchParams.get('v')));
        if(value.encoding)res.setHeader('content-encoding',value.encoding);
        if (staticAssetMatches(req.headers['if-none-match'], value.etag)) { res.writeHead(304); res.end(); return; }
        const contentType=type.startsWith('text/')?`${type}; charset=utf-8`:type;
        res.writeHead(200, { 'content-type': contentType, 'content-length': value.bytes.length }); res.end(req.method === 'HEAD' ? undefined : value.bytes); return;
      }
      if (req.method === 'GET' && TOKEN_METADATA_PATH.test(path)) {
        try { return send(200,await launches.metadata(path.split('/').at(-1).slice(0,-5))); } catch { return send(404,{error:'Token metadata not found.'}); }
      }
      if(path==='/api/analytics'){
        if(req.method!=='GET')return send(405,{error:'Public analytics is read-only.'});
        limits.check(`public-analytics:${ip}`,30);
        if(url.search)return send(400,{error:'Public analytics does not accept request parameters.'});
        return send(200,await analyticsReport.read());
      }
      if(PAD&&path.startsWith('/api/pad/')){
        if (req.method === 'GET') limits.check(`pad-read:${ip}`, 240); else limits.check(`pad-write:${ip}`, 10);
        const [status, result] = await PAD.handlePublic(req.method, path, url.searchParams, () => bodyJson(req, { maxBytes: 5_000_000, sizeMessage: 'The images are too large.' }), { requestHost: String(req.headers.host || '').slice(0, 253) });
        return send(status, result);
      }
      if(PAD&&req.method==='GET'&&/^\/pad-media\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(path)){
        const bytes=await PAD.mediaFile(path.split('/').at(-1));if(!bytes)return send(404,{error:'Not found.'});
        res.writeHead(200,{'content-type':path.endsWith('.png')?'image/png':path.endsWith('.webp')?'image/webp':'image/jpeg','cache-control':'public, max-age=31536000, immutable','content-length':bytes.length});res.end(bytes);return;
      }
      if(path==='/api/explore'||path.startsWith('/api/explore/')){
        if(req.method!=='GET')return send(405,{error:'This market feed is read-only.'});
        // Verified viewers get their own allowance even behind a shared NAT.
        // A forged cookie never creates an authenticated rate-limit identity.
        const viewerToken = cookieToken(req), viewer = viewerToken ? await accounts.getSession(viewerToken) : null;
        const viewerKey = viewer ? `account:${viewer.account.id}` : `ip:${ip}`;
        limits.check(`explore:${viewerKey}`,120);
        if(path==='/api/explore')return send(200,await discovery.list(Object.fromEntries(url.searchParams)));
        if(path==='/api/explore/updates'){limits.check(`explore-updates:${viewerKey}`,30);if(url.search)return send(400,{error:'Launch updates do not accept request parameters.'});return send(200,await discovery.updates());}
        if(path==='/api/explore/users'){limits.check(`explore-users:${viewerKey}`,60);return send(200,await discovery.users(Object.fromEntries(url.searchParams)));}
        if(path==='/api/explore/creator')return send(200,await discovery.creator(url.searchParams.get('username'),url.searchParams.get('offset')));
        if(path==='/api/explore/token')return send(200,await discovery.token(url.searchParams.get('mint')));
        if(path==='/api/explore/market'){limits.check(`explore-market:${viewerKey}`,30);return send(200,await discovery.market(url.searchParams.get('mint')));}
        if(path==='/api/explore/trades'){limits.check(`explore-trades:${viewerKey}`,30);return send(200,await discovery.trades(url.searchParams.get('mint')));}
        if(path==='/api/explore/holders'){limits.check(`explore-holders:${viewerKey}`,20);return send(200,await discovery.holders(url.searchParams.get('mint')));}
        if(path==='/api/explore/rewards'){limits.check(`explore-rewards:${viewerKey}`,30);return send(200,await discovery.rewards(url.searchParams.get('mint')));}
        return send(404,{error:'Market feed not found.'});
      }
      if(path==='/api/gotchi'||path.startsWith('/api/gotchi/')){
        if(req.method!=='GET')return send(405,{error:'Gotchi pages are read-only.'});
        const viewerToken=cookieToken(req), viewer=viewerToken?await accounts.getSession(viewerToken):null;
        const viewerKey=viewer?`account:${viewer.account.id}`:`ip:${ip}`;
        limits.check(`gotchi:${viewerKey}`,60);
        if(path==='/api/gotchi'){if(url.search)return send(400,{error:'The Gotchi list does not accept request parameters.'});return send(200,await gotchi.list());}
        if(path==='/api/gotchi/detail'){limits.check(`gotchi-detail:${viewerKey}`,30);return send(200,await gotchi.detail(url.searchParams.get('id')));}
        if(path==='/api/gotchi/coin'){limits.check(`gotchi-coin:${viewerKey}`,60);return send(200,{attachment:await gotchi.attachment(url.searchParams.get('mint'))});}
        return send(404,{error:'Gotchi page not found.'});
      }
      if(path==='/api/launchpad/meteora/hook-allowlist'||path==='/api/launchpad/meteora/hook-blocklist'){
        // Public, read-only (v71.28): a hooked coin's allowlist or blocklist, read from the hook program's accounts when the RPC answers
        // and otherwise as recorded by Launchpad (src/meteora-service.mjs hookAllowlist / hookBlocklist). No session, no keys.
        const list=path.endsWith('allowlist')?'allowlist':'blocklist';
        if(req.method!=='GET')return send(405,{error:`The ${list} is read-only here.`});
        const viewerToken=cookieToken(req), viewer=viewerToken?await accounts.getSession(viewerToken):null;
        limits.check(`meteora-hook-${list}:${viewer?`account:${viewer.account.id}`:`ip:${ip}`}`,60);
        return send(200,await (list==='allowlist'?meteoraLaunches.hookAllowlist(url.searchParams.get('mint')):meteoraLaunches.hookBlocklist(url.searchParams.get('mint'))));
      }
      if(req.method==='GET'&&(path==='/api/launchpad/robinhood/status'||path==='/api/launchpad/robinhood/coin'||path==='/api/launchpad/robinhood/pairs')){
        // Public, read-only: availability and blockers, the pair list (ETH, USDG, approved stocks and ETFs with prices) and a live coin's panel. No keys.
        const viewerToken=cookieToken(req), viewer=viewerToken?await accounts.getSession(viewerToken):null;
        limits.check(`robinhood:${viewer?`account:${viewer.account.id}`:`ip:${ip}`}`,120);
        if(path.endsWith('/status'))return send(200,await robinhoodLaunch.status(viewer));
        if(path.endsWith('/pairs'))return send(200,await robinhoodLaunch.pairs(viewer));
        const view=await robinhoodLaunch.coinView(url.searchParams.get('mint')||url.searchParams.get('token'));
        return view?send(200,view):send(404,{error:'This Robinhood Chain coin was not found.'});
      }
      if(req.method==='GET'&&(path==='/api/launchpad/pump-classic/status'||path==='/api/launchpad/pump-classic/coin'||path==='/api/launchpad/pump-classic/pairs')){
        // Public, read-only: availability, Pump.fun's live pair list (cached) and a live coin's verified recipients and allocations. No keys.
        const viewerToken=cookieToken(req), viewer=viewerToken?await accounts.getSession(viewerToken):null;
        const viewerKey=viewer?`account:${viewer.account.id}`:`ip:${ip}`;
        limits.check(`pump-classic:${viewerKey}`,120);
        if(path.endsWith('/status'))return send(200,await pumpClassic.status(viewer));
        if(path.endsWith('/pairs'))return send(200,await pumpClassic.pairs(viewer));
        return send(200,await pumpClassic.coinView(url.searchParams.get('mint')));
      }
      // v71.30 AI influencer: X account connection (src/agent/x-http.mjs), influencer views, creator controls,
      // reference uploads and generated media (src/agent/influencer-http.mjs). Each handler checks the session
      // and CSRF itself with the helpers passed here and answers through send() or res directly.
      if(path.startsWith('/api/launchpad/x/')||path.startsWith('/api/launchpad/agents/influencer')||path.startsWith('/influencer-media/')){
        const ctx={req,res,path,url,ip,send,limits,accounts,cookieToken,csrfSession,bodyJson,agents,origin,configured};
        if(await handleXRoutes(ctx))return; if(await handleInfluencerRoutes(ctx))return;
        return send(404,{error:'Not found.'});
      }
      if(req.method==='GET'&&(path==='/api/launchpad/agents'||path.startsWith('/api/launchpad/agents/'))&&!['/api/launchpad/agents/me','/api/launchpad/agents/fund/status'].includes(path)){
        // Public read models of AI Agent mode: no session, no keys, no provider internals.
        const viewerToken=cookieToken(req), viewer=viewerToken?await accounts.getSession(viewerToken):null;
        const viewerKey=viewer?`account:${viewer.account.id}`:`ip:${ip}`;
        limits.check(`agents:${viewerKey}`,180);
        await agents.ensure();
        const views=agents.views, mint=url.searchParams.get('mint');
        // v71.37 moderation: an admin viewer sees hidden agents (marked) in the directory and can open them; a creator can open their own hidden agent.
        const who=viewer?{moderator:viewer.account.role==='admin'&&monitorAllowed(viewer),accountId:viewer.account.id}:null;
        if(path==='/api/launchpad/agents')return send(200,views.list({cursor:url.searchParams.get('cursor'),limit:Number(url.searchParams.get('limit'))||24,viewer:who}));
        if(path==='/api/launchpad/agents/catalog')return send(200,views.catalog());
        if(path==='/api/launchpad/agents/policy')return send(200,views.policy());
        if(path==='/api/launchpad/agents/agent')return send(200,views.detail(mint,{viewer:who}));
        if(path==='/api/launchpad/agents/activity')return send(200,views.activity(mint,{viewer:who,before:url.searchParams.get('before'),after:url.searchParams.get('after'),limit:url.searchParams.get('limit')}));
        if(path==='/api/launchpad/agents/treasury')return send(200,views.treasury(mint,{viewer:who}));
        if(path==='/api/launchpad/agents/runs')return send(200,views.runs(mint,{viewer:who,before:url.searchParams.get('before'),limit:url.searchParams.get('limit')}));
        if(path==='/api/launchpad/agents/receipts')return send(200,views.receipts(mint,{viewer:who,limit:url.searchParams.get('limit')}));
        if(path==='/api/launchpad/agents/memory')return send(200,views.memory(mint,{viewer:who,before:url.searchParams.get('before'),limit:url.searchParams.get('limit')}));
        if(path==='/api/launchpad/agents/browser')return send(200,views.browser(mint,{viewer:who}));
        if(path==='/api/launchpad/agents/screenshot'){
          limits.check(`agents-shot:${viewerKey}`,120);
          const shot=views.screenshot(url.searchParams.get('id'));
          res.writeHead(200,{'content-type':'image/jpeg','cache-control':'public, max-age=30','content-length':shot.bytes.length});res.end(shot.bytes);return;
        }
        if(path==='/api/launchpad/agents/stream'){
          // Shared read fan-out: one listener per viewer, no provider session per viewer.
          limits.check(`agents-stream:${viewerKey}`,20);
          const agent=views.requireAgent(mint), lastId=Number(req.headers['last-event-id']||url.searchParams.get('after')||0)||0;
          // One viewer (an address, or a signed-in account) holds a few streams at most, so a single
          // client cannot occupy the shared live-view capacity. Refused viewers fall back to polling.
          if((agentStreamViewers.get(viewerKey)||0)>=AGENT_STREAMS_PER_VIEWER){res.setHeader('retry-after','15');return send(429,{error:'Too many live agent views are open from this connection. Close an unused tab.',retryAfterMs:15000});}
          if(agentStreams.size>=400){res.setHeader('retry-after','15');return send(503,{error:'Too many live viewers right now. Refresh shortly.',retryAfterMs:15000});}
          agentStreamViewers.set(viewerKey,(agentStreamViewers.get(viewerKey)||0)+1);
          const releaseViewer=()=>{const left=(agentStreamViewers.get(viewerKey)||1)-1;if(left>0)agentStreamViewers.set(viewerKey,left);else agentStreamViewers.delete(viewerKey);};
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
          const write=event=>{if(res.destroyed||res.writableEnded)return;res.write(`id: ${event.id}\nevent: activity\ndata: ${json(event)}\n\n`);};
          res.write(`retry: 5000\nevent: hello\ndata: ${json({mint,at:Date.now()})}\n\n`);
          for(const event of views.activity(mint,{after:lastId,limit:50}).events)write(event);
          let latest=lastId;
          const listener=payload=>{if(payload.agentId!==agent.id)return;try{for(const event of views.activity(mint,{after:latest,limit:20}).events){write(event);latest=Math.max(latest,event.id);}if(payload.kind==='screenshot')res.write(`event: browser\ndata: ${json(views.browser(mint))}\n\n`);}catch{}};
          agents.events.on('event',listener);
          const heartbeat=setInterval(()=>{if(res.destroyed||res.writableEnded)return;res.write(': keep-alive\n\n');},25000);
          const streamKey=Symbol('agent-stream');agentStreams.set(streamKey,()=>{clearInterval(heartbeat);agents.events.off('event',listener);releaseViewer();});
          req.on('close',()=>{agentStreams.get(streamKey)?.();agentStreams.delete(streamKey);});
          return;
        }
        return send(404,{error:'Agent page not found.'});
      }
      if (['/api/launchpad/damm-pump/status','/api/launchpad/damm-pump/pairs','/api/launchpad/pump/status','/api/launchpad/pump/pairs','/api/launchpad/meteora/status','/api/launchpad/meteora/pairs'].includes(path)) {
        if(req.method!=='GET')return send(405,{error:'Method not allowed.'});
        if(url.search)return send(400,{error:'Launch status does not accept request parameters.'});
        const previewToken=cookieToken(req), control=String(req.headers['x-control-token']||'');
        const previewChecked=previewToken?await csrfSession(previewToken,control):null;
        const previewSession=previewChecked?.csrfValid?previewChecked.session:null;
        // Verified accounts retain independent allowances behind shared NATs.
        // Unknown cookies or mismatched CSRF tokens keep the anonymous IP budget.
        const statusViewer=previewSession?`account:${previewSession.account.id}`:`ip:${ip}`;
        limits.check(`pump-public-status:${statusViewer}`,60);
        const previewContext=previewSession?{sessionToken:previewToken,authorize:async()=>{
          const current=await csrfSession(previewToken,control);
          if(!current.session||!current.csrfValid||current.session.account.id!==previewSession.account.id)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});
          return current.session;
        }}:undefined;
        return send(200,await (path.startsWith('/api/launchpad/damm-pump/')?dammPumpLaunches:path.startsWith('/api/launchpad/meteora/')?meteoraLaunches:publicPump).publicStatus(previewSession,previewContext));
      }
      const token = cookieToken(req);
      const checked = token ? await csrfSession(token, String(req.headers['x-control-token'] || '')) : { session: null, csrfValid: false }, session = checked.session;
      if (req.method === 'GET' && path === '/api/session') {
        limits.check(`session-read:${session ? `account:${session.account.id}` : `ip:${ip}`}`, 120);
        if (!session) return send(200, { accounts: true, authenticated: false, portfolio: features.toolkit });
        let pumpTestAllowed=false;
        if(monitorAllowed(session)){try{await ownerOnly(session);pumpTestAllowed=true;}catch{ /* Hidden unless the current owner can be resolved. */ }}
        return send(200, { accounts: true, authenticated: true, portfolio: features.toolkit, token: session.csrfToken, account: session.account, authMethod:session.authMethod, walletVerified:session.walletVerified===true, walletAddress:session.walletVerified===true?session.walletAddress:null, monitorAllowed: monitorAllowed(session), pumpTestAllowed, ...(features.toolkit ? { fees: await policy.get(session.account.id) } : {}) });
      }
      if (req.method === 'POST' && ['/api/wallet/challenge','/api/wallet/verify'].includes(path)) {
        if (req.headers.origin !== origin) return send(403,{error:'Use the Launchpad website to connect your wallet.'});
        limits.check(`wallet-auth:${ip}`,20,5*60000);
        const body = await bodyJson(req);
        if (path.endsWith('/challenge')) {
          const binding = randomBytes(32).toString('hex');
          const challenge = await accounts.walletChallenge(body.address,origin,binding,{accountId:body.accountId});
          res.setHeader('set-cookie',`launchpad-wallet-proof=${binding}; Path=/api/wallet; HttpOnly; SameSite=Strict; Max-Age=300${configured?'; Secure':''}`);
          return send(200,challenge);
        }
        const binding = String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('launchpad-wallet-proof='))?.slice('launchpad-wallet-proof='.length)||'';
        if (!/^[a-f0-9]{64}$/.test(binding)) return send(403,{error:'Connect your wallet again.'});
        const account = await accounts.authenticateWallet(body,origin,binding,{maxUsers});
        const next = await accounts.createWalletSession(account);
        if (token) await accounts.revokeSession(token);
        setCookie(next.token,Math.max(1,Math.floor((next.expiresAt-Date.now())/1000)));
        const verifiedSession=await accounts.getSession(next.token);
        return send(200,{authenticated:true,account:next.account,token:next.csrfToken,authMethod:verifiedSession?.authMethod||'password',walletVerified:verifiedSession?.walletVerified===true,walletAddress:verifiedSession?.walletVerified===true?verifiedSession.walletAddress:null});
      }
      if (req.method === 'POST' && ['/api/account/register', '/api/account/login'].includes(path)) {
        limits.check(`auth:${ip}`, 40);
        const body = await bodyJson(req);
        const usernameKey = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : '';
        limits.check(`login:${ip}:${usernameKey}`, 10, 15 * 60000);
        let account;
        if (path.endsWith('/register')) {
          account = await accounts.register(body.username, body.password, { maxUsers });
        } else account = await accounts.authenticate(body.username, body.password, body.code, { source: ip });
        if (token) await accounts.revokeSession(token);
        const next = await accounts.createAuthenticatedSession(account);
        setCookie(next.token, Math.max(1, Math.floor((next.expiresAt - Date.now()) / 1000)));
        return send(200, { authenticated: true, account, token: next.csrfToken, authMethod:'password',walletVerified:false,walletAddress:null });
      }
      if (!path.startsWith('/api/')) return notFound();
      if (!session) return send(401, { error: 'Sign in to your Launchpad account.' });
      if (!checked.csrfValid) return send(403, { error: 'Refresh this page to reconnect.' });
      const account = session.account, id = account.id;
      if (account.authType === 'wallet' && !(path === '/api/launchpad' || path.startsWith('/api/launchpad/') || path === '/api/account/logout' || path === '/api/account' && req.method === 'GET' || ['/api/account/profile','/api/account/avatar','/api/account/cashback-wallet','/api/account/cashback-wallet/challenge','/api/account/evm-wallet','/api/account/evm-wallet/challenge','/api/account/evm-wallet/unlink'].includes(path) && req.method === 'POST')) return send(403,{error:'This wallet session is limited to launching and managing coins.'});
      if (account.authType === 'wallet' && path === '/api/launchpad/export') return send(403,{error:'Wallet exports are unavailable for connected-wallet launches.'});
      limits.check(`api:${id}`, 600);
      if (req.method === 'GET' && path === '/api/admin/health') {
        requireAdmin(session); limits.check(`host-health:${id}`, 30);
        const snapshot = health.snapshot();
        if (tokenTrading?.discoveryIncomplete) snapshot.services.tradeRecovery = 'degraded';
        return send(200, { ...snapshot, capacity: operatorCapacity({rpcUrl:launchpadEnv('PUBLIC_RPC_URL')||'',jupiterKey:launchpadEnv('PUBLIC_JUPITER_KEY')||''}), maxUsers });
      }
      const sendView = (code, value) => send(code, publicStatus(value, monitorAllowed(session)));
      if(req.method==='POST'&&['/api/account/signin-wallet','/api/account/signin-wallet/challenge','/api/account/signin-wallet/unlink'].includes(path)){
        limits.check(`signin-wallet:${id}`,10,15*60000);
        const body=await bodyJson(req),context={token,origin};
        if(path.endsWith('/challenge'))return send(200,await accounts.walletLinkChallenge(id,body,context));
        const updated=path.endsWith('/unlink')?await accounts.unlinkWallet(id,body,context):await accounts.linkWallet(id,body,context);
        // Link changes invalidate wallet-authenticated sessions. The completed
        // link/unlink already required this account's fresh password and MFA.
        if(session.walletVerified){
          const next=await accounts.createLinkedAccountSession(updated);
          setCookie(next.token,Math.max(1,Math.floor((next.expiresAt-Date.now())/1000)));
          return send(200,{account:next.account,token:next.csrfToken});
        }
        return send(200,{account:updated});
      }
      if(req.method==='POST'&&['/api/account/evm-wallet','/api/account/evm-wallet/challenge','/api/account/evm-wallet/unlink'].includes(path)){
        // The linked EVM wallet (v71.40): proof of the wallet (a personal signature) plus the account's own verification;
        // no session rotation, since it is not a sign-in method.
        limits.check(`evm-wallet:${id}`,10,15*60000);
        const body=await bodyJson(req),context={token,origin};
        if(path.endsWith('/challenge'))return send(200,await accounts.evmWalletChallenge(id,body,context));
        return send(200,{account:path.endsWith('/unlink')?await accounts.unlinkEvmWallet(id,body,context):await accounts.linkEvmWallet(id,body,context)});
      }
      if(req.method==='POST'&&['/api/account/cashback-wallet','/api/account/cashback-wallet/challenge'].includes(path)){
        limits.check(`cashback-wallet:${id}`,10,15*60000);
        const body=await bodyJson(req),context={token,origin};
        if(path.endsWith('/challenge'))return send(200,await accounts.cashbackWalletChallenge(id,body.address,context));
        return send(200,{account:await accounts.setCashbackWallet(id,body,context)});
      }
      if(req.method==='POST'&&path==='/api/account/profile'){
        limits.check(`profile:${id}`,20);const profile=await accounts.updateProfile(id,await bodyJson(req));await discovery.pendingRegistry;discovery.registryLoaded=false;return send(200,{account:profile});
      }
      if(req.method==='POST'&&path==='/api/account/avatar'){
        // The profile form accepts 5 MiB originals and resizes before sending.
        // Keep stored images bounded even when callers bypass that form.
        const sizeMessage='This profile picture is too large. Choose a smaller image and upload it using the profile form.';
        limits.check(`avatar:${id}`,6,5*60000);const body=await bodyJson(req,{maxBytes:Math.ceil(MAX_LAUNCH_IMAGE/3)*4+1024,sizeMessage});
        if(typeof body.data!=='string')return send(400,{error:'Choose a PNG, JPG or WebP profile picture.'});
        if(body.data.length>Math.ceil(MAX_LAUNCH_IMAGE/3)*4||Buffer.byteLength(body.data,'base64')>MAX_LAUNCH_IMAGE)return send(413,{error:sizeMessage});
        
        return send(200,await launches.uploadImage(id,body.data));
      }
      if(path==='/api/admin/pump-test'||path.startsWith('/api/admin/pump-test/')){
        requireAdmin(session); await ownerOnly(session);
        if(url.search)return send(400,{error:'Private testing does not accept query parameters.'});
        const action=path.slice('/api/admin/pump-test'.length);
        const fundedActions=['/funded/status','/funded/prepare','/funded/submit','/funded/reconcile'];
        const deploymentActions=['/deployment/status','/deployment/prepare','/deployment/submit','/deployment/reconcile'];
        if(!['','/pairs','/preview',...fundedActions,...deploymentActions].includes(action))return send(404,{error:'Not found.'});
        const isFunded=fundedActions.includes(action),isDeployment=deploymentActions.includes(action);
        const readOnly=['','/pairs','/funded/status','/deployment/status'].includes(action);
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`pump-test:${action}:${id}`,readOnly?30:action.endsWith('/submit')?10:20);
        const input=readOnly?null:await bodyJson(req,{maxBytes:isDeployment?262144:isFunded?8192:4096});
        const context={sessionToken:token,authorize:async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.session||!current.csrfValid||current.session.account.id!==id)throw Object.assign(Error('Session changed. Sign in again.'),{statusCode:403});
          requireAdmin(current.session); await ownerOnly(current.session); return current.session;
        }};
        let value;
        try {
        if(isFunded){const method=action.split('/').at(-1);value=method==='status'?await pumpFunded.status(session,context):await pumpFunded[method](session,input,context);}
        else if(isDeployment){
          const method=action.split('/').at(-1),service=pumpDeploymentService();value=method==='status'?await service.status(session,context):await service[method](session,input,context);
        }else value=action==='/preview'?await pumpLab.preview(session,input):action==='/pairs'?await pumpLab.pairs(session):await pumpLab.read(session);
        } catch(error) {
          if((isFunded||isDeployment)&&!error.statusCode)throw Object.assign(Error('Private test operation is unavailable. Refresh its saved status before retrying.'),{statusCode:409});
          throw error;
        }
        await context.authorize();
        return send(200,value);
      }
      if (path.startsWith('/api/admin/damm-pump-test/')) {
        requireAdmin(session);await ownerOnly(session);
        const action=path.slice('/api/admin/damm-pump-test/'.length),deploymentMatch=/^(deployment|configuration)\/(status|prepare|submit|reconcile)$/.exec(action),readOnly=['status','launches','operations'].includes(action)||deploymentMatch?.[2]==='status';
        const methods={status:'ownerStatus',setup:'setup',launches:'listAccount',operations:'operations',prepare:'prepare',submit:'submit',reconcile:'reconcile',cancel:'cancel',wallet:'wallet',market:'market'};
        if(!Object.hasOwn(methods,action)&&!deploymentMatch)return send(404,{error:'Private PumpSwap test action not found.'});
        if(url.search)return send(400,{error:'Private PumpSwap testing does not accept query parameters.'});
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`damm-pump-test:${action}:${id}`,action==='reconcile'?60:readOnly||['wallet','market'].includes(action)?30:deploymentMatch?6:15);
        const input=readOnly?null:await bodyJson(req,{maxBytes:deploymentMatch?262144:16384});
        const context={sessionToken:token,authorize:async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.session||!current.csrfValid||current.session.account.id!==id)throw Object.assign(Error('The owner session changed. Sign in again.'),{statusCode:403});
          requireAdmin(current.session);await ownerOnly(current.session);return current.session;
        }};
        let value;
        if(deploymentMatch){const service=deploymentMatch[1]==='configuration'?dammTestDeploymentService().configuration:dammTestDeploymentService(),method=deploymentMatch[2];value=readOnly?await service[method](session,context):await service[method](session,input,context);}
        else value=readOnly?await dammPumpTestLaunches[methods[action]](session,context):await dammPumpTestLaunches[methods[action]](session,input,context);
        await context.authorize();return send(200,value);
      }
      if (path.startsWith('/api/admin/damm-pump/')) {
        requireAdmin(session); await ownerOnly(session);
        const action=path.slice('/api/admin/damm-pump/'.length), deploymentMatch=/^(deployment|configuration)\/(status|prepare|submit|reconcile)$/.exec(action), readOnly=action==='status'||deploymentMatch?.[2]==='status';
        if(!['status','setup','configure','claim-fees'].includes(action)&&!deploymentMatch)return send(404,{error:'Not found.'});
        if(url.search)return send(400,{error:'PumpSwap setup does not accept query parameters.'});
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`damm-pump-admin:${action}:${id}`,readOnly?30:6);
        const input=readOnly?null:await bodyJson(req,{maxBytes:deploymentMatch?262144:8192});
        const context={sessionToken:token,authorize:async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.session||!current.csrfValid||current.session.account.id!==id)throw Object.assign(Error('Session changed. Sign in again.'),{statusCode:403});
          requireAdmin(current.session); await ownerOnly(current.session); return current.session;
        }};
        let value;
        if(deploymentMatch){const service=deploymentMatch[1]==='configuration'?dammDeploymentService().configuration:dammDeploymentService(),method=deploymentMatch[2];value=readOnly?await service[method](session,context):await service[method](session,input,context);}
        else value=readOnly?await dammPumpLaunches.ownerStatus(session,context):await dammPumpLaunches[action==='configure'?'setEnabled':action==='claim-fees'?'claimFees':action](session,input,context);
        await context.authorize();return send(200,value);
      }
      if (path.startsWith('/api/admin/pump-public/')) {
        requireAdmin(session); await ownerOnly(session);
        const action=path.slice('/api/admin/pump-public/'.length), deploymentMatch=/^(deployment|configuration)\/(status|prepare|submit|reconcile)$/.exec(action), readOnly=action==='status'||deploymentMatch?.[2]==='status';
        if(!['status','setup','configure'].includes(action)&&!deploymentMatch)return send(404,{error:'Not found.'});
        if(url.search)return send(400,{error:'PumpSwap setup does not accept query parameters.'});
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`pump-public-admin:${action}:${id}`,readOnly?30:6);
        const input=readOnly?null:await bodyJson(req,{maxBytes:deploymentMatch?262144:8192});
        const context={sessionToken:token,authorize:async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.session||!current.csrfValid||current.session.account.id!==id)throw Object.assign(Error('Session changed. Sign in again.'),{statusCode:403});
          requireAdmin(current.session); await ownerOnly(current.session); return current.session;
        }};
        let value;
        if(deploymentMatch){const service=deploymentMatch[1]==='configuration'?publicDeploymentService().configuration:publicDeploymentService(),method=deploymentMatch[2];value=readOnly?await service[method](session,context):await service[method](session,input,context);}
        else value=readOnly?await publicPump.ownerStatus(session,context):await publicPump[action==='configure'?'setEnabled':action](session,input,context);
        await context.authorize();return send(200,value);
      }
      if (path.startsWith('/api/admin/meteora/')) {
        requireAdmin(session); await ownerOnly(session);
        const action=path.slice('/api/admin/meteora/'.length), readOnly=action==='status';
        if(!['status','setup','configure','pairs','refresh-pairs'].includes(action))return send(404,{error:'Meteora control not found.'});
        const getOnly=readOnly||action==='pairs';
        if(url.search||req.method!==(getOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`meteora-admin:${action}:${id}`,getOnly?20:6);
        const input=getOnly?null:await bodyJson(req,{maxBytes:4096});
        const context={sessionToken:token,authorize:async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.session||!current.csrfValid||current.session.account.id!==id)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});
          requireAdmin(current.session);await ownerOnly(current.session);return current.session;
        }};
        let value;
        if(action==='pairs')value=meteoraIntegration?await meteoraIntegration.quotes.list({includeUnavailable:true,limitChecks:0}):{assets:[]};
        else if(action==='refresh-pairs'){void meteoraIntegration?.warm({force:true});value={scheduled:true};}
        else value=readOnly?await meteoraLaunches.ownerStatus(session,context):await meteoraLaunches[action==='configure'?'setEnabled':'setup'](session,input,context);
        if(action==='setup')void meteoraIntegration?.warm();
        await context.authorize();return send(200,value);
      }
      if (path.startsWith('/api/launchpad/meteora/')) {
        const action=path.slice('/api/launchpad/meteora/'.length), readOnly=['launches','operations'].includes(action);
        const methods={launches:'listAccount',operations:'operations',prepare:'prepare',submit:'submit',reconcile:'reconcile',confirm:'reconcile',cancel:'cancel',wallet:'wallet',reroute:'rerouteCreator'};
        if(!Object.hasOwn(methods,action))return send(404,{error:'Meteora action not found.'});
        if(url.search||req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`meteora:${action}:${id}`,['reconcile','confirm'].includes(action)?60:readOnly||action==='wallet'?30:15);
        const input=readOnly?null:await bodyJson(req,{maxBytes:16384});
        const context={sessionToken:token,authorize:async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.session||current.session.account.id!==id)throw Object.assign(Error('Sign in again to launch or trade.'),{statusCode:401});
          if(!current.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});return current.session;
        }};
        const value=readOnly?await meteoraLaunches[methods[action]](session,context):await meteoraLaunches[methods[action]](session,input,context);
        await context.authorize();
        if(value?.operation?.action==='initialize'&&['confirmed','finalized','failed','expired'].includes(value.operation.state)){await discovery.pendingRegistry;discovery.registryLoaded=false;}
        return send(200,value);
      }
      if (path.startsWith('/api/launchpad/damm-pump/')) {
        const action=path.slice('/api/launchpad/damm-pump/'.length), readOnly=['launches','operations'].includes(action);
        if(!['launches','operations','prepare','submit','reconcile','cancel','wallet'].includes(action))return send(404,{error:'PumpSwap action not found.'});
        if(url.search)return send(400,{error:'PumpSwap actions do not accept query parameters.'});
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`damm-pump:${action}:${id}`,action==='reconcile'?60:readOnly||action==='wallet'?30:15);
        const input=readOnly?null:await bodyJson(req,{maxBytes:16384});
        const context={sessionToken:token,authorize:async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.session||current.session.account.id!==id)throw Object.assign(Error('Sign in again before launching or trading.'),{statusCode:401});
          if(!current.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});
          return current.session;
        }};
        const value=readOnly?await dammPumpLaunches[action==='launches'?'listAccount':'operations'](session,context):await dammPumpLaunches[action](session,input,context);
        await context.authorize();
        if (value?.operation?.action==='initialize' && ['confirmed','finalized','failed','expired'].includes(value.operation.state)) {
          // The new coin link must not hit a pre-launch discovery snapshot.
          await discovery.pendingRegistry; discovery.registryLoaded=false;
        }
        return send(200,value);
      }
      if (path.startsWith('/api/launchpad/pump/')) {
        const action=path.slice('/api/launchpad/pump/'.length), readOnly=['launches','operations'].includes(action);
        if(!['launches','operations','prepare','submit','reconcile','cancel','wallet'].includes(action))return send(404,{error:'PumpSwap action not found.'});
        if(url.search)return send(400,{error:'PumpSwap actions do not accept query parameters.'});
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`pump-public:${action}:${id}`,action==='reconcile'?60:readOnly||action==='wallet'?30:15);
        const input=readOnly?null:await bodyJson(req,{maxBytes:16384});
        const context={sessionToken:token,authorize:async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.session||current.session.account.id!==id)throw Object.assign(Error('Sign in again before launching or trading.'),{statusCode:401});
          if(!current.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});
          return current.session;
        }};
        const value=readOnly?await publicPump[action==='launches'?'listAccount':'operations'](session,context):await publicPump[action](session,input,context);
        await context.authorize();
        if (value?.operation?.action==='initialize' && ['confirmed','finalized','failed','expired'].includes(value.operation.state)) {
          // The new coin link must not hit a pre-launch discovery snapshot.
          await discovery.pendingRegistry; discovery.registryLoaded=false;
        }
        return send(200,value);
      }
      if(path.startsWith('/api/admin/launchpad/')){
        requireAdmin(session);
        if(req.method==='GET'&&path==='/api/admin/launchpad/capabilities')return send(200,{adjustableMarketCap:true,minUsd:20000,maxUsd:100000,defaultUsd:20000});
        if(req.method!=='POST')return send(405,{error:'Method not allowed.'});
        const action=path.slice('/api/admin/launchpad/'.length);
        if(!['prepare','estimate','create'].includes(action))return send(404,{error:'Unknown administrator launch action.'});
        limits.check(`launch-${action}:${id}`,action==='create'?6:20);
        const body=await bodyJson(req);
        assertRaydiumLaunchRequest(body);
        return send(200,await launches[action](id,body,{adminLaunch:true}));
      }
      if (path.startsWith('/api/funding')) {
        limits.check(`funding:${id}`,30);
        if(req.method==='GET'&&path==='/api/funding')return send(200,await fundingService.overview(id,url.searchParams.get('chain')));
        if(req.method!=='POST')return send(405,{error:'Method not allowed.'});
        const body=await bodyJson(req);
        if(path==='/api/funding/configure'){requireAdmin(session);limits.check(`funding-key:${id}`,5,15*60000);await accounts.reauthenticate(id,body.password,body.code);const value=await fundingService.configure(body.apiKey,id);await accounts.audit(id,'funding-key-updated');return send(200,value);}
        if(path==='/api/funding/quote'){limits.check(`funding-quote:${id}`,6);return send(200,await fundingService.quote(id,body));}
        if(path==='/api/funding/create')return send(200,await fundingService.create(id,body.id,body.reviewHash));
        if(path==='/api/funding/refresh')return send(200,await fundingService.refresh(id,body.id));
        return send(404,{error:'Unknown funding request.'});
      }
      if (path.startsWith('/api/launchpad/trading/')) {
        if(req.method!=='POST')return send(405,{error:'Method not allowed.'});
        const action=path.slice('/api/launchpad/trading/'.length);
        if(!['wallet','quote','prepare','submit','status','cancel'].includes(action))return send(404,{error:'Trade action not found.'});
        limits.check(`token-trade:${id}`,90);
        if(['quote','prepare','submit'].includes(action))limits.check(`token-trade-${action}:${id}`,15);
        const body=await bodyJson(req,{maxBytes:16384}),csrf=String(req.headers['x-control-token']||'');
        const context={sessionToken:token,authorize:async()=>{
          const verification=await csrfSession(token,csrf),current=verification.session;
          if(!current||current.account.id!==id)throw Object.assign(Error('Sign in again before trading.'),{statusCode:401});
          if(!verification.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});
          return current;
        }};
        return send(200,await tradingService()[action](id,body,context));
      }
      if (path.startsWith('/api/launchpad/market/')) {
        if(req.method!=='GET')return send(405,{error:'Method not allowed.'});
        const action=path.slice('/api/launchpad/market/'.length),readLimits={pools:30,'live-trades':120,holders:30,'holder-history':20};
        if(!Object.hasOwn(readLimits,action))return send(404,{error:'Market data was not found.'});
        // Each read has its own allowance; polling never consumes launch or
        // wallet-approval limits. Resolve the owned launch before any provider.
        limits.check(`launch-market-${action}:${id}`,readLimits[action]);
        const {launch}=await launches.marketTradeContext(id,url.searchParams.get('id'));
        const feed=marketFeeds.forAccount?await marketFeeds.forAccount(id):marketFeeds;
        const mint=launch.mint,pair=url.searchParams.get('pair')||'';
        if(action==='pools')return send(200,await feed.pools('solana',mint,pair));
        if(action==='live-trades')return send(200,await feed.liveTrades('solana',mint,pair));
        if(action==='holders')return send(200,await feed.holders('solana',mint));
        return send(200,await feed.holderHistory('solana',mint,url.searchParams.get('wallet')));
      }
      if(path==='/api/launchpad/gotchi/holdings'){
        if(req.method!=='GET')return send(405,{error:'Method not allowed.'});
        if(url.search)return send(400,{error:'Gotchi holdings do not accept request parameters.'});
        limits.check(`gotchi-holdings:${id}`,20);
        const wallet=session.walletVerified===true?session.walletAddress:account.mainWallet;
        if(!wallet)return send(200,{wallet:null,gotchis:[],at:Date.now()});
        const result=await gotchi.holdings(wallet),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again to see your Gotchi standings.'});
        return send(200,result);
      }
      if(path.startsWith('/api/launchpad/robinhood/')){
        const action=path.slice('/api/launchpad/robinhood/'.length), readOnly=['launches','launch','pair-check'].includes(action);
        if(!['launches','launch','pair-check','quote','fund/prepare','fund/submit','cancel'].includes(action))return send(404,{error:'Robinhood launch action not found.'});
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`robinhood-${readOnly?'read':'write'}:${id}`,action==='quote'?12:action==='pair-check'?20:readOnly?60:30);
        const csrf=String(req.headers['x-control-token']||''),context={sessionToken:token,authorize:async()=>{const verification=await csrfSession(token,csrf),current=verification.session;if(!current||current.account.id!==id)throw Object.assign(Error('Sign in again before launching.'),{statusCode:401});if(!verification.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});}};
        const body=readOnly?Object.fromEntries(url.searchParams):await bodyJson(req,{maxBytes:16384});
        if(action==='launches'){await context.authorize();return send(200,await robinhoodLaunch.mine(session));}
        if(action==='launch'){await context.authorize();return send(200,await robinhoodLaunch.ownLaunch(session,body));}
        if(action==='pair-check'){await context.authorize();return send(200,await robinhoodLaunch.pairCheck(session,body));}
        if(action==='quote')return send(200,await robinhoodLaunch.quote(session,body,context));
        if(action==='fund/prepare'){limits.check(`robinhood-fund:${id}`,10);return send(200,await robinhoodLaunch.prepareFunding(session,body,context));}
        if(action==='fund/submit')return send(200,await robinhoodLaunch.submitFunding(session,body,context));
        if(action==='cancel'){await context.authorize();return send(200,await robinhoodLaunch.cancel(session,body));}
      }
      if(path.startsWith('/api/launchpad/pump-classic/')){
        const action=path.slice('/api/launchpad/pump-classic/'.length), readOnly=['launches','launch'].includes(action);
        if(!['launches','launch','quote','fund/prepare','fund/submit','cancel'].includes(action))return send(404,{error:'Pump.fun launch action not found.'});
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`pump-classic-${readOnly?'read':'write'}:${id}`,action==='quote'?12:readOnly?60:30);
        const csrf=String(req.headers['x-control-token']||''),context={sessionToken:token,authorize:async()=>{const verification=await csrfSession(token,csrf),current=verification.session;if(!current||current.account.id!==id)throw Object.assign(Error('Sign in again before launching.'),{statusCode:401});if(!verification.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});return current;}};
        const body=readOnly?Object.fromEntries(url.searchParams):await bodyJson(req,{maxBytes:16384});
        if(action==='launches'){await context.authorize();return send(200,await pumpClassic.mine(session));}
        if(action==='launch'){await context.authorize();return send(200,await pumpClassic.ownLaunch(session,body));}
        if(action==='quote')return send(200,await pumpClassic.quote(session,body,context));
        if(action==='fund/prepare'){limits.check(`pump-classic-fund:${id}`,10);return send(200,await pumpClassic.prepareFunding(session,body,context));}
        if(action==='fund/submit')return send(200,await pumpClassic.submitFunding(session,body,context));
        if(action==='cancel'){await context.authorize();return send(200,await pumpClassic.cancel(session,body));}
      }
      if(path==='/api/launchpad/agents/me'||path.startsWith('/api/launchpad/agents/')){
        // Creator controls and funding deposits: ownership and CSRF are re-checked after every read.
        const action=path.slice('/api/launchpad/agents/'.length), readOnly=['me','fund/status'].includes(action);
        if(!['me','revise','pause','fund/prepare','fund/submit','fund/cancel','fund/status'].includes(action))return send(404,{error:'Agent action not found.'});
        if(req.method!==(readOnly?'GET':'POST'))return send(405,{error:'Method not allowed.'});
        limits.check(`agents-write:${id}`,action.startsWith('fund')?20:30);
        await agents.ensure();
        const csrf=String(req.headers['x-control-token']||''),context={sessionToken:token,authorize:async()=>{const verification=await csrfSession(token,csrf),current=verification.session;if(!current||current.account.id!==id)throw Object.assign(Error('Sign in again before changing your agent.'),{statusCode:401});if(!verification.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});return current;}};
        const body=readOnly?Object.fromEntries(url.searchParams):await bodyJson(req,{maxBytes:16384});
        if(action==='me'){const current=await context.authorize();const store=agents.store();const mine=store.listAgents({accountId:id,limit:50,includeArchived:true,includeHidden:true}).agents.map(agent=>agents.creatorView(agent));return send(200,{agents:mine,at:Date.now(),wallet:current.walletVerified===true?current.walletAddress:current.account.mainWallet||null});}
        if(action==='revise')return send(200,await agents.revise(session,body,context));
        if(action==='pause')return send(200,await agents.setCreatorPause(session,body,context));
        if(action==='fund/prepare'){limits.check(`agents-fund-prepare:${id}`,6);return send(200,await agents.prepareFunding(session,body,context));}
        if(action==='fund/submit')return send(200,await agents.submitFunding(session,body,context));
        if(action==='fund/cancel')return send(200,await agents.cancelFunding(session,body));
        if(action==='fund/status'){await context.authorize();return send(200,await agents.fundingStatus(session,body));}
      }
      if(path==='/api/launchpad/earnings'){
        if(req.method!=='GET')return send(405,{error:'Method not allowed.'});
        limits.check(`personal-rewards:${id}`,30);
        const csrf=String(req.headers['x-control-token']||''),context={authorize:async()=>{const verification=await csrfSession(token,csrf),current=verification.session;if(!current||current.account.id!==id)throw Object.assign(Error('Sign in again to see your rewards.'),{statusCode:401});if(!verification.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});return current;}};
        return send(200,await personalRewards.read(id,context));
      }
      if(path==='/api/launchpad/fee-assignments'||path==='/api/launchpad/fee-assignments/claim'||path==='/api/launchpad/fee-assignments/redirect'){
        const mutation=path.endsWith('/claim')?'claim':path.endsWith('/redirect')?'redirect':null;if(req.method!==(mutation?'POST':'GET'))return send(405,{error:'Method not allowed.'});
        if(url.search)return send(400,{error:'Fee assignments do not accept request parameters.'});
        limits.check(`assigned-fees${mutation?'-'+mutation:''}:${id}`,mutation?10:30);
        const csrf=String(req.headers['x-control-token']||''),context={authorize:async()=>{const verification=await csrfSession(token,csrf),current=verification.session;if(!current||current.account.id!==id)throw Object.assign(Error('Sign in again before checking assigned fees.'),{statusCode:401});if(!verification.csrfValid)throw Object.assign(Error('Refresh this page to reconnect.'),{statusCode:403});return current;}};
        const result=mutation?await feeAssignments[mutation](id,await bodyJson(req,{maxBytes:4096}),context):await feeAssignments.list(id,context);await context.authorize();
        if(mutation==='redirect'){discovery.registryLoaded=false;discovery.listCache?.clear();}
        return send(200,result);
      }
      if (path.startsWith('/api/launchpad')) {
        // Read-only chart polling must not consume wallet-approval limits.
        limits.check(`${path==='/api/launchpad/trades'?'launch-trades':path==='/api/launchpad/market'?'launch-market':path==='/api/launchpad/rewards'?'launch-rewards':'launchpad'}:${id}`,path==='/api/launchpad/rewards'?30:120);
        if (req.method==='GET'&&path==='/api/launchpad') return send(200,await launches.read(id));
        if (req.method==='GET'&&path==='/api/launchpad/quotes'){
          const catalogue=await launches.quotes(id);
          const verification=await csrfSession(token,String(req.headers['x-control-token']||'')),current=verification.session;
          if(!current||current.account.id!==id)return send(401,{error:'Sign in again before choosing a pair.'});
          if(!verification.csrfValid)return send(403,{error:'Refresh this page to reconnect.'});
          const canViewComingSoon=current.account.role==='admin'&&monitorAllowed(current);
          return send(200,{...catalogue,canViewComingSoon,assets:canViewComingSoon?catalogue.assets:catalogue.assets.filter(asset=>asset.supported===true)});
        }
        if (req.method==='GET'&&path==='/api/launchpad/balance') return send(200,await launches.balance(id,url.searchParams.get('id')));
        if (req.method==='GET'&&path==='/api/launchpad/market')return send(200,await launches.market(id,url.searchParams.get('id')));
        if (req.method==='GET'&&path==='/api/launchpad/rewards')return send(200,await launches.rewards(id,url.searchParams.get('id')));
        if (req.method==='GET'&&path==='/api/launchpad/trades'){
          const {launch,snapshot}=await launches.marketTradeContext(id,url.searchParams.get('id'));
          return send(200,await marketFeeds.launchTrades(id,launch,snapshot));
        }
        if (req.method!=='POST') return send(405,{error:'Method not allowed.'});
        const body=await bodyJson(req);
        if(['/api/launchpad/prepare','/api/launchpad/estimate','/api/launchpad/create'].includes(path))assertRaydiumLaunchRequest(body);
        if(path==='/api/launchpad/prepare'){limits.check(`launch-prepare:${id}`,20);return send(200,await launches.prepare(id,body));}
        if(path==='/api/launchpad/estimate'){limits.check(`launch-estimate:${id}`,20);return send(200,await launches.estimate(id,body));}
        if(path==='/api/launchpad/image'){limits.check(`launch-image:${id}`,20,5*60000);return send(200,await launches.uploadImage(id,body.data));}
        if(path==='/api/launchpad/create'){limits.check(`launch-create:${id}`,6);return send(200,await launches.create(id,body));}
        if(path==='/api/launchpad/review')return send(200,await launches.refresh(id,body.id));
        if(path==='/api/launchpad/signature')return send(200,await launches.signature(id,body.id,body.operationId));
        if(path==='/api/launchpad/sign')return send(200,await launches.sign(id,body.id,body.operationId,body.transaction));
        if(path==='/api/launchpad/archive'){
          limits.check(`launch-archive:${id}`,30);
          return send(200,await launches.archive(id,body.id,{archived:body.archived}));
        }
        if(path==='/api/launchpad/action'){
          if(body.action==='holder-distribute')return send(403,{error:'Manual holder distributions are available only in the admin panel.'});
          if(body.action==='rewards-settings')return send(403,{error:'Automatic holder rewards have a fixed $100 minimum.'});
          return send(200,await launches.action(id,body.id,body.action,body));
        }
        if(path==='/api/launchpad/fees/claim-all'){limits.check(`launch-claim-all:${id}`,10);return send(200,await launches.claimAll(id));}
        if(path==='/api/launchpad/export'){limits.check(`launch-export:${id}`,5,15*60000);await accounts.reauthenticate(id,body.password,body.code);const value=await launches.exportWallet(id,body.id);await accounts.audit(id,'launch-wallet-exported');return send(200,value);}
        return send(404,{error:'Unknown launchpad request.'});
      }
      if(path==='/api/account/connections/husher'){
        requireAdmin(session);limits.check(`husher-connection:${id}`,10,15*60000);
        if(req.method==='GET')return send(200,await fundingService.connection(id));
        if(req.method!=='POST')return send(405,{error:'Method not allowed.'});
        const body=await bodyJson(req);await accounts.reauthenticate(id,body.password,body.code);requireAdmin(await accounts.getSession(token));
        if(body.action==='reveal'){const value=await fundingService.reveal(id);await accounts.audit(id,'husher-key-revealed');return send(200,value);}
        if(body.action==='save'){const value=await fundingService.configure(body.apiKey,id);await accounts.audit(id,'husher-key-updated');return send(200,value);}
        return send(400,{error:'Choose reveal or save.'});
      }
      if (req.method === 'GET' && path === '/api/trading-overview') return sendView(200, await diagnostics.overview(id, url.searchParams.get('chain') || 'solana'));
      if (path === '/api/account/connections') {
        limits.check(`connections:${id}`, 30);
        if (req.method === 'GET') return send(200, await connections.read(id, url.searchParams.get('chain') || 'solana'));
        if (req.method === 'POST') { const value = await bodyJson(req); return send(200, await connections.save(id, value.chain, value.values, value.revision)); }
        return send(405, { error: 'Method not allowed.' });
      }
      if (req.method === 'GET' && path.startsWith('/api/market/')) {
        if(path==='/api/market/live-trades')limits.check(`market-live:${id}`,120);
        else if(path==='/api/market/holder-history')limits.check(`market-history:${id}`,20);
        else limits.check(`market:${id}`, 30);
        const chain = url.searchParams.get('chain'), address = url.searchParams.get('address');
        const feed = marketFeeds.forAccount ? await marketFeeds.forAccount(id) : marketFeeds;
        if (path === '/api/market/pools') return send(200, await feed.pools(chain, address, url.searchParams.get('pair') || ''));
        if (path === '/api/market/trades') return send(200, await feed.trades(chain, address));
        if (path === '/api/market/candles') return send(200, await feed.candles(chain,address,url.searchParams.get('interval') || '1m',url.searchParams.get('unit') || 'base'));
        if (path === '/api/market/live-trades') return send(200, await feed.liveTrades(chain,address,url.searchParams.get('pair')||''));
        if (path === '/api/market/holder-history') return send(200, await feed.holderHistory(chain,address,url.searchParams.get('wallet')));
        if (path === '/api/market/holders') return send(200, await feed.holders(chain, address));
        return send(404, { error: 'Unknown market-data request.' });
      }
      if(req.method==='POST'&&['/api/admin/moderation/user','/api/admin/moderation/launch'].includes(path)){
        requireAdmin(session);limits.check(`moderation:${id}`,20);
        const body=await bodyJson(req);
        // Hide/restore is a reversible visibility action within an already
        // MFA-verified admin session. User bans still require fresh proof.
        if(path==='/api/admin/moderation/user')await accounts.reauthenticate(id,body.password,body.code);
        requireAdmin(await accounts.getSession(token));
        if(path.endsWith('/launch')&&body.route!==undefined&&!['pumpswap','raydium','damm-pump','meteora','pump-classic','robinhood'].includes(body.route))return send(400,{error:'Choose a valid launch route.'});
        const result=path.endsWith('/user')?await accounts.moderateUser(id,body):body.route==='robinhood'?await robinhoodLaunch.adminVisibility(id,{id:body.id,mint:body.mint,hidden:body.hidden,reason:body.reason}):body.route==='pump-classic'?await pumpClassic.adminVisibility(id,{accountId:body.accountId,id:body.id,mint:body.mint,hidden:body.hidden,reason:body.reason}):body.route==='meteora'?await meteoraLaunches.adminVisibility(id,{accountId:body.accountId,id:body.id,mint:body.mint,hidden:body.hidden,reason:body.reason}):body.route==='damm-pump'?await dammPumpLaunches.adminVisibility(id,{accountId:body.accountId,id:body.id,mint:body.mint,hidden:body.hidden,reason:body.reason}):body.route==='pumpswap'?await publicPump.adminVisibility(id,{accountId:body.accountId,id:body.id,mint:body.mint,hidden:body.hidden,reason:body.reason}):await launchAdmin.visibility(id,body);
        requireAdmin(await accounts.getSession(token));
        await discovery.pendingRegistry;discovery.registryLoaded=false;discovery.listCache?.clear();
        return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/launches'){
        requireAdmin(session);limits.check(`launch-admin:${id}`,30);
        return send(200,await launchAdmin.list(id,{search:url.searchParams.get('search')||'',offset:url.searchParams.get('offset')||0,limit:url.searchParams.get('limit')||10,view:url.searchParams.get('view')||'active'}));
      }
      if(path==='/api/admin/launches/archive'){
        requireAdmin(session);
        if(req.method!=='POST')return send(405,{error:'Method not allowed.'});
        limits.check(`launch-admin-archive:${id}`,30);
        const body=await bodyJson(req);
        requireAdmin(await accounts.getSession(token));
        if(body.route==='pump-classic')return send(409,{error:'Pump.fun launch requests are managed in the Pump.fun tab. Live Pump.fun coins can be hidden here.'});
        if(body.route==='robinhood')return send(409,{error:'Robinhood launch requests are managed in the Robinhood tab. Live Robinhood coins can be hidden here.'});
        if(body.route!==undefined&&!['pumpswap','raydium','damm-pump','meteora'].includes(body.route))return send(400,{error:'Choose a valid launch route.'});
        const result=body.route==='meteora'?await meteoraLaunches.adminArchive(id,{accountId:body.accountId,id:body.id,mint:body.mint,archived:body.archived}):body.route==='damm-pump'?await dammPumpLaunches.adminArchive(id,{accountId:body.accountId,id:body.id,mint:body.mint,archived:body.archived}):body.route==='pumpswap'?await publicPump.adminArchive(id,{accountId:body.accountId,id:body.id,mint:body.mint,archived:body.archived}):await launchAdmin.archive(id,{accountId:body.accountId,id:body.id,archived:body.archived});
        requireAdmin(await accounts.getSession(token));
        await discovery.pendingRegistry;discovery.registryLoaded=false;discovery.listCache?.clear();
        return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/revenue'){
        requireAdmin(session);limits.check(`admin-revenue:${id}`,12);
        return send(200,await revenueReport.read(id));
      }
      if(path==='/api/admin/reward-diagnostics'){
        requireAdmin(session);if(req.method!=='GET')return send(405,{error:'Reward diagnostics are read-only.'});
        limits.check(`admin-reward-diagnostics:${id}`,6);
        const result=await rewardDiagnostics.read(id),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before viewing reward diagnostics.'});
        requireAdmin(current.session);return send(200,result);
      }
      if(path==='/api/admin/pairs'||path==='/api/admin/pairs/check'){
        requireAdmin(session);
        const checking=path.endsWith('/check');if(req.method!==(checking?'POST':'GET'))return send(405,{error:'Method not allowed.'});
        limits.check(`admin-pairs-${checking?'check':'read'}:${id}`,checking?12:20);
        const input=checking?await bodyJson(req):null;
        const result=await(checking?pairCatalogue.previewMint(id,{mint:input.mint}):pairCatalogue.read(id));
        const current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before viewing custom pairs.'});
        requireAdmin(current.session);return send(200,result);
      }
      if(req.method==='GET'&&(path==='/api/admin/revenue-audit'||path==='/api/admin/volume')){
        requireAdmin(session);limits.check(`admin-report:${id}`,24);
        const result=await(path==='/api/admin/volume'?volumeReport:revenueAudit).read(id);
        const current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before viewing this report.'});
        requireAdmin(current.session);
        return send(200,result);
      }
      if(path==='/api/admin/burn-history'){
        requireAdmin(session);
        if(!['GET','POST'].includes(req.method))return send(405,{error:'Method not allowed.'});
        if(url.search)return send(400,{error:'Burn history does not accept request parameters.'});
        limits.check(`admin-burn-history:${req.method}:${id}`,req.method==='GET'?24:6);
        const authorize=async()=>{
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.csrfValid||current.session?.account?.id!==id)throw Object.assign(Error('Sign in again before updating burn history.'),{statusCode:401});
          requireAdmin(current.session);
        };
        if(req.method==='GET') { const result=await burnHistory.read(id);await authorize();return send(200,result); }
        const input=await bodyJson(req,{maxBytes:8192});
        await accounts.reauthenticate(id,input.password,input.code);
        await authorize();
        const result=await burnHistory.add(id,{burnLink:input.burnLink,buybackLink:input.buybackLink},{authorize});
        analyticsReport.invalidate?.();
        return send(200,result);
      }
      if(req.method==='GET'&&(path==='/api/admin/agents'||path==='/api/admin/agents/health')){
        requireAdmin(session);await ownerOnly(session);
        // Releasing orphan browsers changes provider state: POST only, with the admin action checks.
        if(path.endsWith('/health')&&url.searchParams.get('releaseOrphans')==='1'){res.setHeader('allow','POST');return send(405,{error:'Releasing orphan browsers changes provider state. Confirm it with your password and authenticator code.'});}
        limits.check(`admin-agents:${id}`,30);
        if(!agents.available())return send(200,{version:1,disabled:true,reason:'AI Agent mode is disabled on this host. Set LAUNCHPAD_AGENTS_ENABLED=1 and the provider settings in /etc/launchpad.env, then restart.',flags:null,effective:{master:false},agents:[],alerts:[],at:Date.now()});
        const result=path.endsWith('/health')?await agents.providerHealth(id,{releaseOrphans:false}):await agents.views.inspect(id),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again to inspect agents.'});
        return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/vanity'){
        requireAdmin(session);await ownerOnly(session);limits.check(`admin-vanity:${id}`,30);
        const current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again to see vanity addresses.'});
        // Paged lists (25 a page in the admin panel); without parameters the full lists are returned as before.
        const q=url.searchParams,part=prefix=>q.has(prefix+'Offset')||q.has(prefix+'Limit')||q.has(prefix+'State')?{offset:q.get(prefix+'Offset')??undefined,limit:q.get(prefix+'Limit')??undefined,state:q.get(prefix+'State')||''}:undefined;
        return send(200,await vanity.view(id,{search:q.get('search')||'',pool:part('pool'),used:part('used')}));
      }
      if(req.method==='GET'&&path==='/api/admin/robinhood'){
        requireAdmin(session);await ownerOnly(session);limits.check(`admin-robinhood:${id}`,30);
        const q=url.searchParams,paged=q.has('offset')||q.has('limit');
        const result=await robinhoodLaunch.adminOverview(id,paged?{offset:q.get('offset')??0,limit:q.get('limit')??25,search:q.get('search')||'',state:q.get('state')||'',mode:q.get('mode')||'',archived:q.get('archived')==='1'||q.get('archived')==='true'}:{}),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again to inspect Robinhood launches.'});
        return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/pump-classic'){
        requireAdmin(session);await ownerOnly(session);limits.check(`admin-pump-classic:${id}`,30);
        // Paged and filtered when the panel asks for a page; the full owner view otherwise.
        const q=url.searchParams,paged=q.has('offset')||q.has('limit');
        const result=await pumpClassic.adminOverview(id,paged?{offset:q.get('offset')??0,limit:q.get('limit')??25,search:q.get('search')||'',state:q.get('state')||'',mode:q.get('mode')||'',archived:q.get('archived')==='1'||q.get('archived')==='true'}:{}),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again to inspect Pump.fun launches.'});
        return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/gotchi'){
        requireAdmin(session);await ownerOnly(session);limits.check(`admin-gotchi:${id}`,12);
        const result=await gotchi.inspect(id),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before viewing Gotchi controls.'});
        requireAdmin(current.session);await ownerOnly(current.session);return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/protocol-treasury'){
        requireAdmin(session);limits.check(`admin-treasury:${id}`,12);
        return send(200,await treasury.read(id));
      }
      if(req.method==='GET'&&path==='/api/admin/protocol-gas-funding'){
        requireAdmin(session);limits.check(`admin-gas-funding:${id}`,12);
        const result=await gasFunding.read(id),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before viewing gas funding.'});
        requireAdmin(current.session);return send(200,result);
      }
      if(PAD&&path.startsWith('/api/admin/pad/')){
        requireAdmin(session);limits.check(`admin-pad:${id}`,60);
        const [status,result]=await PAD.handleAdmin(req.method,path,()=>bodyJson(req,{maxBytes:4096}));return send(status,result);
      }
      if(req.method==='GET'&&path==='/api/admin/overview'){
        requireAdmin(session);limits.check(`admin-overview:${id}`,30);
        return send(200,await operator.overview(id));
      }
      if(req.method==='GET'&&path==='/api/admin/holder-distributions'){
        requireAdmin(session);limits.check(`admin-holder-distributions:${id}`,30);
        const result=await operator.readHolderDistributions(id),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before viewing holder distributions.'});
        requireAdmin(current.session);return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/reward-sweeps'){
        requireAdmin(session);limits.check(`admin-reward-sweeps:${id}`,30);
        const result=await operator.readRewardSweeps(id),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before viewing reward conversions.'});
        requireAdmin(current.session);return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/cleanup'){
        requireAdmin(session);limits.check(`admin-cleanup:${id}`,30);
        const q=url.searchParams,result=await cleanupAdmin.list(id,{search:q.get('search')||'',venue:q.get('venue')||'',kind:q.get('kind')||'',includeArchived:q.get('archived')==='1'||q.get('archived')==='true',offset:q.get('offset')??0,limit:q.get('limit')??25});
        const current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before reviewing unfinished launches.'});
        requireAdmin(current.session);return send(200,result);
      }
      if(req.method==='GET'&&path==='/api/admin/failed-launch-archive'){
        requireAdmin(session);limits.check(`admin-failed-launch-archive:${id}`,12);
        const result=await failedLaunchArchive.preview(id),current=await csrfSession(token,String(req.headers['x-control-token']||''));
        if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before reviewing failed requests.'});
        requireAdmin(current.session);return send(200,result);
      }
      if(req.method==='GET'&&path.startsWith('/api/admin/protocol-fees')){
        requireAdmin(session);limits.check(`admin-protocol:${id}`,30);
        if(path==='/api/admin/protocol-fees')return send(200,await protocolRevenue.read(id));
        if(path==='/api/admin/protocol-fees/coins')return send(200,await protocolRevenue.coins(id));
        return send(404,{error:'Unknown protocol fee request.'});
      }
      if(req.method==='GET'&&path==='/api/admin/branding'){
        requireAdmin(session);limits.check(`admin-branding:${id}`,30);
        return send(200,await platformBranding.list(id));
      }
      if (req.method === 'GET' && path.startsWith('/api/admin/session')) {
        requireAdmin(session); limits.check(`diagnostics:${id}`, 60);
        if (path === '/api/admin/sessions') return send(200, await diagnostics.list({ search: url.searchParams.get('search') || '', page: url.searchParams.get('page') || 0 }));
        if (path === '/api/admin/session') {
          const result = await diagnostics.detail(url.searchParams.get('accountId'), url.searchParams.get('chain'), url.searchParams.get('kind'));
          if (url.searchParams.get('export') === '1') { await accounts.audit(id, 'session-activity-exported'); res.setHeader('content-disposition', `attachment; filename=launchpad-${result.account.username}-${result.chain}-${result.kind}.json`); }
          return send(200, result);
        }
        return send(404, { error: 'Unknown session request.' });
      }
      if (await robinhoodApi({ path, method: req.method, url, body: () => bodyJson(req), account, session, currentSession:()=>accounts.getSession(token), accounts, manager: robinhood?.runtimes, policy: robinhood?.policy, send, sendView, requireAdmin, limits })) return;
      if (req.method === 'GET') {
        if (path === '/api/account') return send(200, { account, ...(features.toolkit ? { fees: await policy.get(id), cashback: await cashbackSummary(accounts.storeFor(id)) } : {}) });
        if (path === '/api/account/settings') return send(200, protect(id, await runtimes.readSettings(id)));
        if (path === '/api/account/security') return send(200, { events: await accounts.securityEvents(id) });
        if (path === '/api/wallet-balances') { limits.check(`balances:${id}`, 8); const { settings } = await runtimes.readSettings(id); return send(200, await runtimes.balances.read(id, settings)); }
        if (path === '/api/sniper/status') return sendView(200, await runtimes.view(id, 'sniper'));
        if (path === '/api/status') return sendView(200, await runtimes.view(id, 'copy'));
        if (path === '/api/portfolio/status') return sendView(200, await runtimes.view(id, url.searchParams.get('kind') || 'liquidity', url.searchParams.get('mode')));
        if (path === '/api/runtime/status') return sendView(200, runtimes.get(id).status());
        if (path === '/api/admin/accounts') {
          requireAdmin(session);
          // Optional search and paging for the admin panel; the full list is returned as before without them.
          const q = url.searchParams, search = String(q.get('search') || '').trim().toLowerCase().slice(0, 64), all = await accounts.list();
          if (!q.has('search') && !q.has('offset') && !q.has('limit')) return send(200, { accounts: all });
          const offset = Number(q.get('offset') ?? 0), limit = Number(q.get('limit') ?? 25);
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return send(400, { error: 'Invalid account page.' });
          const matched = search ? all.filter(row => [row.username, row.mainWallet, row.id].some(value => String(value || '').toLowerCase().includes(search))) : all;
          return send(200, { accounts: matched.slice(offset, offset + limit), total: matched.length, totalAll: all.length, offset, limit, nextOffset: offset + limit < matched.length ? offset + limit : null, search });
        }
        if (path === '/api/events') {
          if ((streams.get(id) || 0) >= 5) { res.setHeader('retry-after', '15'); return send(429, { error: 'Too many open live views. Close an unused Launchpad tab.', retryAfterMs: 15000 }); }
          streams.set(id, (streams.get(id) || 0) + 1);
          const runtime = runtimes.get(id); let busy = false, timer, closed = false, dirty = false;
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
          const flush = async () => {
            if (closed) return;
            if (busy || res.writableNeedDrain) { dirty = true; return; }
            busy = true; dirty = false;
            try {
              const currentSession = await accounts.getSession(token);
              if (!currentSession) { res.end(); return; }
              const status = await runtimes.view(id, url.searchParams.get('kind') === 'sniper' ? 'sniper' : 'copy');
              if (!closed) res.write(`data: ${json(publicStatus(status, monitorAllowed(currentSession)))}\n\n`);
            } catch { res.end(); } finally { busy = false; if (dirty && !closed && !res.writableNeedDrain) changed(); }
          };
          const changed = () => { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 35); };
          const heartbeat = setInterval(flush, 15000);
          runtime.on('change', changed); res.on('drain', changed);
          res.on('close', () => { closed = true; clearTimeout(timer); clearInterval(heartbeat); runtime.off('change', changed); const remaining = (streams.get(id) || 1) - 1; remaining ? streams.set(id, remaining) : streams.delete(id); });
          await flush(); return;
        }
        return send(404, { error: 'Not found.' });
      }
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
      // Vanity key imports carry up to 2,000 keypairs (solana-keygen files are ~230 bytes each).
      const body = await bodyJson(req, path === '/api/admin/vanity/import' && account.role === 'admin' ? { maxBytes: 1048576, sizeMessage: 'That is too much at once. Add at most 2,000 keys per batch.' } : undefined);
      if (path === '/api/account/logout') { await accounts.revokeSession(token); setCookie('', 0); return send(200, { ok: true }); }
      if (path === '/api/account/export') {
        limits.check(`export:${id}`, 5, 15 * 60000);
        const value = await accounts.exportMainWallet(id, body.password, body.code);
        await accounts.audit(id, 'main-wallet-exported'); return send(200, value);
      }
      // Password change, 2FA removal and "sign out everywhere" revoke every other session. This browser
      // just proved the password (and second factor), so it continues with a fresh session token and
      // CSRF token; if that replacement cannot be issued it is signed out as before.
      const keepCurrentSession = async result => {
        let next = null;
        try { next = await accounts.createAuthenticatedSession(result); } catch { next = null; }
        if (!next) { setCookie('', 0); return send(200, { ok: true }); }
        setCookie(next.token, Math.max(1, Math.floor((next.expiresAt - Date.now()) / 1000)));
        return send(200, { ok: true, token: next.csrfToken, account: next.account, authMethod: 'password', walletVerified: false, walletAddress: null });
      };
      if (path === '/api/account/password') {
        limits.check(`password:${id}`, 5, 15 * 60000);
        return keepCurrentSession(await accounts.changePassword(id, body.password, body.newPassword, body.code));
      }
      if (path.startsWith('/api/account/mfa/') || ['/api/account/logout-all', '/api/account/settings-export', '/api/account/telegram-link', '/api/account/telegram-unlink'].includes(path)) {
        limits.check(`security:${id}`, 10, 15 * 60000);
        if (path === '/api/account/mfa/setup') return send(200, await accounts.beginMfa(id, body.password));
        if (path === '/api/account/mfa/enable') {
          const result = await accounts.enableMfa(id, body.password, body.code);
          const next = await accounts.createAuthenticatedSession(result);
          setCookie(next.token, Math.floor((next.expiresAt - Date.now()) / 1000));
          return send(200, { ...result, token: next.csrfToken, account: next.account });
        }
        if (path === '/api/account/mfa/disable') return keepCurrentSession(await accounts.disableMfa(id, body.password, body.code));
        if (path === '/api/account/logout-all') return keepCurrentSession(await accounts.revokeAllAccess(id, body.password, body.code));
        await accounts.reauthenticate(id, body.password, body.code);
        if (path === '/api/account/settings-export') { const result = await resolve(id, body.settings || (await runtimes.readSettings(id)).settings); await accounts.audit(id, 'full-setup-exported'); return send(200, { settings: result }); }
        if (path === '/api/account/telegram-link') { const result = await accounts.createLinkCode(id); await accounts.audit(id, 'telegram-link-created'); return send(200, result); }
        if (path === '/api/account/telegram-unlink') { if (account.telegramId) await accounts.unlinkTelegram(account.telegramId, id); await accounts.audit(id, 'telegram-disconnected'); return send(200, { ok: true }); }
      }
      if (path === '/api/account/settings') return send(200, protect(id, await runtimes.saveSettings(id, await resolve(id, body.settings), body.revision)));
      if (path === '/api/account/wallets/generate') {
        limits.check(`wallet-generation:${id}`, 10);
        const result = await runtimes.generateWallets(id, await resolve(id, body.settings), body.revision, body.count, body.kind || 'copy');
        await accounts.audit(id, 'trading-wallets-generated');
        return send(200, protect(id, result));
      }
      if (path.startsWith('/api/admin/')) {
        // Ten confirmed administrator actions per 15 minutes. A used-up allowance is refused before the
        // identity check (so it never consumes an authenticator code) and an action is counted only once
        // reauthentication passes; failed identity checks are bounded by the account's own reauthentication limit.
        requireAdmin(session); limits.peek(`admin:${id}`, 10);
        await accounts.reauthenticate(id, body.password, body.code);
        limits.check(`admin:${id}`, 10, 15 * 60000);
        requireAdmin(await accounts.getSession(token));
        if (path === '/api/admin/cashback') { const updated = await accounts.setCashback(body.accountId, body.cashbackBps); await accounts.audit(id, 'cashback-updated'); return send(200, { account: updated }); }
        if (path === '/api/admin/fees') { await policy.setRecipient(body.recipient); await accounts.audit(id, 'fee-recipient-updated'); return send(200, { fees: await policy.get(id) }); }
        if(path==='/api/admin/launches/recipient')return send(200,await launchAdmin.update(id,body));
        if(path==='/api/admin/launches/action')return send(200,await operator.launchAction(id,body));
        if(path==='/api/admin/holder-distributions'){
          const authorize=async()=>{const current=await csrfSession(token,String(req.headers['x-control-token']||''));if(!current.csrfValid||current.session?.account?.id!==id)throw Object.assign(Error('Sign in again before distributing holder rewards.'),{statusCode:401});requireAdmin(current.session);};
          await authorize();return send(202,await operator.distributeAllHolders(id,{requestId:body.requestId},{authorize}));
        }
        if(path==='/api/admin/reward-sweeps'){
          const authorize=async()=>{const current=await csrfSession(token,String(req.headers['x-control-token']||''));if(!current.csrfValid||current.session?.account?.id!==id)throw Object.assign(Error('Sign in again before selling and distributing rewards.'),{statusCode:401});requireAdmin(current.session);};
          await authorize();return send(202,await operator.distributeAllRewardSweeps(id,{requestId:body.requestId},{authorize}));
        }
        if(path==='/api/admin/failed-launch-archive'){
          const authorize=async()=>{const current=await csrfSession(token,String(req.headers['x-control-token']||''));if(!current.csrfValid||current.session?.account?.id!==id)throw Object.assign(Error('Sign in again before archiving failed requests.'),{statusCode:401});requireAdmin(current.session);};
          await authorize();return send(200,await failedLaunchArchive.archive(id,{requestId:body.requestId},{authorize}));
        }
        if(path==='/api/admin/cleanup/archive-all'){
          // Cleanup → "Archive all finished failures": the saved bulk archive for Raydium, PumpSwap and Meteora
          // requests, then (for the platform owner) every settled Pump.fun failure. Nothing is deleted.
          const authorize=async()=>{const current=await csrfSession(token,String(req.headers['x-control-token']||''));if(!current.csrfValid||current.session?.account?.id!==id)throw Object.assign(Error('Sign in again before archiving failed requests.'),{statusCode:401});requireAdmin(current.session);};
          await authorize();
          const archive=await failedLaunchArchive.archive(id,{requestId:body.requestId},{authorize});
          let pumpFun={skipped:'owner-only',archived:0};
          if(pumpClassic.available()){try{await ownerOnly(session);const reason=typeof body.reason==='string'&&body.reason.trim().length>=5?body.reason.trim().slice(0,500):'Archive all finished failures from the admin panel.';await pumpClassic.adminControl(id,{action:'archive-all',reason});pumpFun={skipped:null,archived:pumpClassic.lastArchiveAll?.archived??0};}catch(error){if(error?.statusCode!==403)throw error;}}
          else pumpFun={skipped:'unavailable',archived:0};
          await authorize();return send(200,{...archive,pumpFun});
        }
        if(path==='/api/admin/protocol-fees/configure')return send(200,await protocolRevenue.configure(id,body));
        if(path==='/api/admin/protocol-fees/claim')return send(200,await protocolRevenue.claim(id,body));
        if(path==='/api/admin/protocol-fees/claim-all')return send(200,await protocolRevenue.claimAll(id,{requestId:body.requestId}));
        if(path==='/api/admin/protocol-fees/activate')return send(200,await protocolRevenue.activate(id,body));
        if(path==='/api/admin/vanity/import'||path==='/api/admin/vanity/remove'){
          await ownerOnly(session);
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before changing vanity addresses.'});
          if(path.endsWith('/import')){const result=await vanity.importKeys({actorId:id,entries:body.entries,scope:body.scope});await accounts.audit(id,'vanity-addresses-added');return send(200,result);}
          const result=await vanity.remove({actorId:id,addresses:body.addresses});await accounts.audit(id,'vanity-addresses-removed');return send(200,result);
        }
        if(path.startsWith('/api/admin/robinhood/')){
          await ownerOnly(session);limits.check(`admin-robinhood-write:${id}`,30);
          if(!robinhoodLaunch.available())return send(503,{error:'Robinhood launches are disabled on this host.'});
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before changing Robinhood controls.'});
          const action=path.slice('/api/admin/robinhood/'.length);
          if(action==='control')return send(200,await robinhoodLaunch.adminControl(id,body));
          if(action==='keys/verify')return send(200,await robinhoodLaunch.verifyKeys(id));
          if(action==='backup')return send(200,await robinhoodLaunch.backup(id));
          return send(404,{error:'Unknown Robinhood administration request.'});
        }
        if(path.startsWith('/api/admin/pump-classic/')){
          await ownerOnly(session);limits.check(`admin-pump-classic-write:${id}`,30);
          if(!pumpClassic.available())return send(503,{error:'Pump.fun launches are disabled on this host.'});
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before changing Pump.fun controls.'});
          const action=path.slice('/api/admin/pump-classic/'.length);
          if(action==='control')return send(200,await pumpClassic.adminControl(id,body));
          if(action==='keys/verify')return send(200,await pumpClassic.verifyKeys(id));
          if(action==='backup')return send(200,await pumpClassic.backup(id));
          return send(404,{error:'Unknown Pump.fun administration request.'});
        }
        if(path.startsWith('/api/admin/agents/')){
          await ownerOnly(session);limits.check(`admin-agents-write:${id}`,30);
          if(!agents.available())return send(503,{error:'AI Agent mode is disabled on this host.'});
          const action=path.slice('/api/admin/agents/'.length);
          if(action==='control')return send(200,await agents.control(id,body));
          if(action==='provider-batch')return send(200,await agents.recordProviderBatch(id,body));
          if(action==='backing')return send(200,await agents.allocateBacking(id,body));
          if(action==='reimburse')return send(200,await agents.requestReimbursement(id,body));
          if(action==='keys/verify')return send(200,await agents.verifyKeys(id));
          if(action==='keys/rotate')return send(200,await agents.rotateKeys(id,body));
          if(action==='backup')return send(200,await agents.backup(id));
          // POST /api/admin/agents/health (the UI keeps its ?releaseOrphans=1 path) releases orphan browsers.
          if(action==='health')return send(200,await agents.providerHealth(id,{releaseOrphans:true}));
          return send(404,{error:'Unknown agent administration request.'});
        }
        if(path==='/api/admin/gotchi/control'||path==='/api/admin/gotchi/retry'){
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before changing Gotchi controls.'});
          requireAdmin(current.session);await ownerOnly(current.session);
          if(path.endsWith('/retry'))return send(200,await gotchi.retry(id,{id:body.id}));
          return send(200,await gotchi.control(id,{id:body.id,enabled:body.enabled,collectionPaused:body.collectionPaused,conversionPaused:body.conversionPaused,settlementPaused:body.settlementPaused,samplingPaused:body.samplingPaused,reason:body.reason}));
        }
        if(path==='/api/admin/protocol-treasury/configure')return send(200,await treasury.configure(id,body));
        if(path==='/api/admin/protocol-treasury/recognize')return send(200,await treasury.recognizeRevenue(id,body));
        if(path==='/api/admin/protocol-treasury/withdraw')return send(200,await treasury.withdrawRetained(id,body));
        if(path==='/api/admin/protocol-gas-funding/configure'){
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before changing gas funding.'});
          requireAdmin(current.session);return send(200,await gasFunding.configure(id,{enabled:body.enabled,expectedAddress:body.expectedAddress,reason:body.reason}));
        }
        if(path==='/api/admin/pairs/save'){
          const current=await csrfSession(token,String(req.headers['x-control-token']||''));
          if(!current.csrfValid||current.session?.account?.id!==id)return send(401,{error:'Sign in again before adding a custom pair.'});
          requireAdmin(current.session);
          return send(200,await pairCatalogue.save(id,{revision:body.revision,name:body.name,ticker:body.ticker,mint:body.mint,image:body.image}));
        }
        if(path==='/api/admin/branding/update')return send(200,await platformBranding.update(id,body));
        return send(404, { error: 'Unknown administrator action.' });
      }
      if (path === '/api/wallets') {
        requireLive(body);
        invariant(Array.isArray(body.wallets) && body.wallets.length <= MAX_STORED_WALLETS, `Maximum ${MAX_STORED_WALLETS} saved wallets.`);
        const resolved = await resolve(id, body);
        const wallets = resolved.wallets.map((row, i) => { const w = parseWallet({ ...row }, i, body.mode); w.keypair?.secretKey.fill(0); return { publicKey: w.publicKey, label: w.label }; });
        return send(200, { wallets });
      }
      const runtime = runtimes.get(id);
      if (path === '/api/sniper/start') { requireLive(body); await runtime.start(await resolve(id, body), 'sniper'); return sendView(200, await runtimes.view(id, 'sniper')); }
      if (path === '/api/sniper/stop') { runtime.stop('sniper'); return sendView(200, await runtimes.view(id, 'sniper')); }
      if (path === '/api/start') { requireLive(body); await runtime.start(await resolve(id, body), 'copy'); return sendView(200, await runtimes.view(id, 'copy')); }
      if (path === '/api/manual-trade') {
        requireLive(body.config);
        try { await runtime.manualTrade(await resolve(id, body.config), body.trade, body.kind || 'copy'); return sendView(200, await runtimes.view(id, body.kind || 'copy', runtime.status(body.kind || 'copy').mode)); }
        catch (error) { return sendView(error.statusCode || 400, { error: errorText(error), status: await runtimes.view(id, body.kind || 'copy', runtime.status(body.kind || 'copy').mode) }); }
      }
      if (path === '/api/stop') { runtime.stop('copy'); return sendView(200, await runtimes.view(id, 'copy')); }
      if (path === '/api/runtime/stop') { runtime.stop(); return sendView(200, runtime.status()); }
      if (path === '/api/portfolio/stop') { invariant(['market', 'liquidity'].includes(body.kind), 'Choose the strategy to stop.'); runtime.stop(body.kind); return sendView(200, await runtimes.view(id, body.kind)); }
      if (path === '/api/portfolio/start') { requireLive(body.config); await runtime.start(await resolve(id, body.config), body.kind); return sendView(200, await runtimes.view(id, body.kind, body.config?.mode)); }
      if (path === '/api/portfolio/claim-fees') { requireLive(body.config); await runtime.claimFees({ wallet: body.wallet, id: body.id }, await resolve(id, body.config)); return sendView(200, await runtimes.view(id, 'liquidity', body.config?.mode)); }
      if (path === '/api/portfolio/withdraw') { requireLive(body.config); await runtime.withdraw({ wallet: body.wallet, id: body.id }, await resolve(id, body.config)); return sendView(200, await runtimes.view(id, 'liquidity', body.config?.mode)); }
      if (path === '/api/portfolio/release') { await runtime.release(body.id, body.mode, body.kind); return sendView(200, await runtimes.view(id, body.kind || 'liquidity', body.mode)); }
      return send(404, { error: 'Unknown action.' });
    } catch (error) {
      if(launchMarketPath(observedPath)&&(error.connectionRequired||retiredProviderInstructions(error.message)))error=Object.assign(Error('Market data is temporarily unavailable. Try refreshing shortly.'),{statusCode:503,retryAfterMs:error.retryAfterMs||15000});
      const dammRequest=dammRequestPath(observedPath),knownTemporary=dammRequest&&dammTransientCodes.has(error.code);
      const providerBusy=dammRequest&&(error.capacityLimited===true||error.rateLimited===true)&&(!error.code||knownTemporary)&&(!error.statusCode||error.statusCode===429||error.statusCode>=500);
      const statusCode=providerBusy?(error.rateLimited?429:503):error.statusCode||(knownTemporary?503:400);
      // OWNER_ONLY tells the admin panel this is an owner-only feature, not lost administrator access.
      const code=error.code==='WALLET_TRANSACTION_REJECTED'||knownTemporary||error.code==='OWNER_ONLY'&&statusCode===403?error.code:providerBusy?'DAMM_RPC_BUSY':null;
      // Our own fixed windows (up to 15 minutes) report their exact wait; provider advice stays capped at 5 minutes.
      const retryAfterMs = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? Math.min(error.rateWindow === true ? 900000 : 300000,error.retryAfterMs) : Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? Math.min(60000,error.retryAfter*1000) : providerBusy?5000:null;
      if (retryAfterMs) res.setHeader('retry-after', String(Math.ceil(retryAfterMs / 1000)));
      send(statusCode, { error: errorText(error), ...(code ? { code } : {}), ...(retryAfterMs ? { retryAfterMs } : {}), ...(error.connectionRequired ? { connectionRequired: true } : {}), ...(error.mfaRequired ? { mfaRequired: true } : {}) });
    }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  // A launchpad that offers Meteora is set up by the server (the managed authority, bound to the launchpad's treasury) and
  // switched on once the authority is funded and the pair checks pass; the owner's own switch always wins afterwards.
  let tenantMeteoraTimer=null;
  function tenantMeteora(){
    const run=async()=>{if(stopping)return;try{await meteoraLaunches.systemSetup();void meteoraIntegration?.warm();const result=await meteoraLaunches.systemEnable();if(result.publicEnabled&&tenantMeteoraTimer){clearInterval(tenantMeteoraTimer);tenantMeteoraTimer=null;}}catch(error){console.warn('[launchpad] Meteora setup is waiting:',errorText(error));}};
    void run();tenantMeteoraTimer=setInterval(run,300000);tenantMeteoraTimer.unref?.();
  }
  server.on('listening', () => { setImmediate(() => { if (!staticWarm.signal.aborted) staticSite.warm({ signal: staticWarm.signal }).catch(() => {}); }); launches.start?.(); publicPump.start?.(); if(dammPumpIntegration)dammPumpIntegration.start();else dammPumpLaunches.start?.(); if(dammPumpTestIntegration)dammPumpTestIntegration.start();else dammPumpTestLaunches.start?.(); if(meteoraIntegration)meteoraIntegration.start();else meteoraLaunches.start?.(); if(TENANT?.venues.includes('meteora'))tenantMeteora(); treasury.start?.(); gasFunding.start?.(); gotchi.start?.(); agents.start?.(); pumpClassic.start?.(); robinhoodLaunch.start?.(); lifetimeReport.start?.(); burnSupplyReport.start?.(); operator.start?.(); health.tradeRecovery = 'starting'; Promise.resolve().then(() => tradingService().start?.()).then(() => { health.tradeRecovery = 'running'; }, () => { health.tradeRecovery = 'unavailable'; }); });
  let closingServices;
  // v71.37: each service closes under its own name, so a stop that drags on can say which one is still saving (host-server logs
  // `pending` after 60 s and leaves at 100 s, inside systemd's 120 s stop timeout, instead of being killed without a word).
  server.closeServices = () => {
    stopping = true; health.close(); staticWarm.abort(); if(tenantMeteoraTimer){clearInterval(tenantMeteoraTimer);tenantMeteoraTimer=null;} for(const [key,close] of agentStreams){close();agentStreams.delete(key);}
    if(closingServices)return closingServices;
    const services=[['launchpad features',()=>{PAD?.stop();setActivePad(null);}],['market feeds',()=>marketFeeds.close?.()],['reward diagnostics',()=>rewardDiagnostics.close?.()],['pair catalogue',()=>pairCatalogue.close?.()],['public Pump.fun',()=>publicPump.stop?.()],['PumpSwap launches',()=>dammPumpIntegration?dammPumpIntegration.stop():dammPumpLaunches.stop?.()],['PumpSwap test launches',()=>dammPumpTestIntegration?dammPumpTestIntegration.stop():dammPumpTestLaunches.stop?.()],['Meteora launches',()=>meteoraIntegration?meteoraIntegration.stop():meteoraLaunches.stop?.()],['Raydium launches',()=>launches.close?.()],['treasury',()=>treasury.close?.()],['gas funding',()=>gasFunding.close?.()],['Gotchi',()=>gotchi.close?.()],['agents',()=>agents.close?.()],['Pump.fun launches',()=>pumpClassic.close?.()],['Robinhood launches',()=>robinhoodLaunch.close?.()],['funding',()=>fundingService?.close?.()],['analytics report',()=>analyticsReport.close?.()],['burn supply report',()=>burnSupplyReport.close?.()],['lifetime report',()=>lifetimeReport.close?.()],['volume report',()=>volumeReport.close?.()],['discovery',()=>discovery.close?.()],['token trading',()=>tokenTrading?.close?.()],['operator',()=>operator.close?.()]];
    const pending=new Set(services.map(([name])=>name));
    closingServices=Promise.allSettled(services.map(([name,close])=>Promise.resolve().then(close).finally(()=>pending.delete(name))));
    closingServices.pending=pending;return closingServices;
  };
  server.on('close', () => { server.closeServices(); });
  return server;
}
