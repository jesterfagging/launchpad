# Launchpad preview harness

Renders the real `public/` frontend of this repository with mocked `/api/*`
data, so pages can be screenshotted in headless Chromium without `npm install`. Nothing under the
source tree is modified; the source path can be changed with `LAUNCHPAD_SOURCE=/path/to/source`.

## Run

The preview finds `public/` and `src/` next to it in the repository (no
`LAUNCHPAD_SOURCE` needed): `start-preview.cmd` (Windows) or `./start-preview.sh`,
then open http://127.0.0.1:4173 — Gotchi Mode at `/gotchi`, `/gotchi?id=fomogotchi`,
the launch form at `/launchpad?mockSession=user`, the admin section at
`/admin?mockSession=admin#tokens/gotchi`. Only Node 22+ is needed for that;
the screenshot tools below also need Playwright and Chromium.

```sh
cd preview
./ctl.sh start            # node server.mjs in the background on :4173 (PORT=…, MOCK_SESSION=…)
./ctl.sh restart          # needed after editing mocks/*.mjs (public/ files are read fresh per request)
./ctl.sh stop | status | log
node --watch server.mjs   # alternative: foreground, auto-restarts when mock code changes

node shoot.mjs /                                   # → shots/home.png
node shoot.mjs "/coin?mint=56rHmw6WonvGiumJRwhNPJ659x9tKhGF2utn35kYNVDV" --full
node shoot.mjs /admin shots/rev.png --session=admin --hash=revenue --full --split=1600
node shoot.mjs /launchpad --session=user --mobile --full
node shoot.mjs /admin --session=admin --hash=tokens '--click=.launch-admin-row>summary'
./verify.sh               # every verified route/tab below → shots/*.png (./verify.sh admin to filter)
```

`shoot.mjs` flags: `--w --h --dpr` · `--full` · `--mobile` (390×844, DPR 2, touch) · `--session=anon|user|admin`
(sets the `mock-session` cookie) · `--wait=1500` (after network idle) · `--hash=revenue` · `--click=<css>`
(repeatable, in order) · `--type=<text>` (keyboard, after clicks) · `--eval=<js>` · `--selector=<css>` (element shot)
· `--split=1600` (also writes `-1.png`, `-2.png`… slices of a tall page) · `--locale/--tz` (default `en-US`/`UTC`;
the container default `en-US@posix` crashes lightweight-charts) · `--no-dex-stub` · `--warnings`.
It prints CSP violations (`securitypolicyviolation` listener), page errors, console errors, same-origin
HTTP ≥400 and failed requests; exit code 1 on CSP violations or page errors. Quote selectors containing `>`.
`dexscreener.com` is unreachable here, so its graduated-coin iframe is replaced by a placeholder page.

## Asset pipeline

By default (`PREVIEW_ASSETS=prod`) pages and files are served through the real
`src/static-assets.mjs` pipeline with the real asset map parsed from `src/account-app.mjs`:
the inline import map and its CSP hash, `?v=<hash>` immutable URLs, modulepreload links, the
font `Link` header, brotli/gzip, ETag/304, and a 404 for any file the real map does not list.
`PREVIEW_ASSETS=raw` serves `public/` files as they are (re-read per request, useful while editing).

## Server behaviour (mirrors `src/account-app.mjs`)

- Same security headers, including the exact `content-security-policy`.
- Page routes: `/`, `/explore` → explore.html · `/coin` · `/launchpad` · `/analytics` · `/admin` · `/docs` `/terms`
  `/privacy` · `/launched-tokens` · `/wallet-account`, `/profile` · `/creator?username=x` → **308** `/user/x` → creator.html.
  Toolkit-only `/trade /robinhood /sessions /funding /tutorial /connections` → 303 `/` (launchpad mode). Other `.html` → 404.
- Static files are read from `public/` on every request; query strings ignored. A request for a public file not
  mentioned in `src/account-app.mjs` logs `[NOT-IN-REAL-ASSET-MAP]` (the real server would 404 it — catches new
  files added by a redesign that also need an `assets.set(...)` line). Private admin modules
  (`admin-meteora-ui.mjs`, `admin-damm-pump-ui.mjs`, …) return 401/403 outside admin mode, like the real server.
- `/token-images/<sha256>.(png|jpg|webp)` → deterministic generated gradient PNG (coin and avatar images).
- `/api/*` gating order matches the real server: `launchpadApi()` allowlist (imported from `src/product-mode.mjs`)
  → public feeds → `/api/session` → 401 without session → wallet-session restrictions → admin role + MFA.
- Unmocked API calls return 501 and log `[UNMOCKED] METHOD /api/path`. `PREVIEW_LOG=all` logs every API call.

Sessions (`MOCK_SESSION`, cookie `mock-session`, or `?mockSession=` on any page URL):
`anon` (default) · `user` = wallet account `mira_builds` (owns OTTER, LEMON, TRCTR + a draft and a failed launch) ·
`admin` = password account `operator`, role admin, `mfaEnabled`, `monitorAllowed`, `pumpTestAllowed` (shows Launch modes).

## Mocked endpoints

Public: `/api/session`, `/api/analytics`, `/api/explore` (stage/sort/search/category/launchMode/age/offset filters),
`/api/explore/{updates,users,creator,token,market,trades,holders,rewards}`,
`/api/launchpad/{pump,meteora,damm-pump}/{status,pairs}`.
Account: `/api/account` (GET), `/api/account/security`, `/api/account/logout`, `/api/launchpad`, `/api/launchpad/{quotes,earnings,
fee-assignments,rewards,market,market/pools,market/holders,market/live-trades,market/holder-history,trades}`,
`/api/launchpad/{pump,meteora,damm-pump}/{launches,operations}`, `/api/launchpad/trading/{status,wallet}`.
Admin (GET): `overview, volume, health, accounts, protocol-fees, protocol-fees/coins, protocol-treasury,
protocol-gas-funding, burn-history, revenue, revenue-audit, reward-diagnostics*, pairs, branding, launches,
holder-distributions, reward-sweeps, failed-launch-archive, launchpad/capabilities, meteora/{status,pairs},
damm-pump/{status,deployment/status,configuration/status}, damm-pump-test/{status,launches,operations,
deployment/status,configuration/status}, pump-public/{status,deployment/status,configuration/status},
pump-test, pump-test/{pairs,funded/status,deployment/status}`.
POST actions (claims, launches, moderation…) are intentionally not mocked (501 + log).
(*reward-diagnostics is download-on-click; not mocked.)

Data: 18 coins (`mocks/data.mjs`) across Raydium / Meteora / PumpSwap(damm-pump) / legacy pumpswap, SOL, USDC, NVDAx,
TSLAx, JUP, SPYx and a pre-IPO quote; new, moving and graduated stages; creator / holders / buyback modes; the official
$LAUNCHPAD mint with a fresh price for the header badge; 240 one-minute candles, a trade tape and top-20 holders per coin.
Mints are deterministic (sha256 seeds) so URLs are stable across restarts. Useful mints: OTTER
`56rHmw6WonvGiumJRwhNPJ659x9tKhGF2utn35kYNVDV` (Raydium curve), HARBR `3saPKZ98mDiY728bop5BUBHtQThz2kBosxFtfpZHiesf`
(Meteora holders), CROW `DS8tQLnGJFXgAm5CfHj4p9XmVrUHBL9gvpu6Fd6xe4sr` (buyback), KOI
`EDSNFaCBnmYjVqv5LG9c7QVxUFfs8tbeEvZKKTADEhSD` (PumpSwap mode), GRID `6H9Skjwo1h71K5PF5ZgdCe9bvdvM9wRbDSTLz2HryuK9` (graduated).

## Verified (no CSP violations, page errors or unmocked calls)

See `verify.sh` → `shots/`: explore (desktop, mobile, graduated tab, search dialog), coin (Raydium curve, holders tab,
Meteora holder rewards, buyback, PumpSwap mode, graduated, official LAUNCHPAD, mobile), launchpad (anon, user, Meteora and
PumpSwap venues), analytics, creator, launched-tokens (anon, user list, drafts, token detail), wallet-account (anon, user),
docs, terms, privacy, admin gate (anon, user) and every admin tab as admin: Overview, Revenue (incl. revenue checks
and reward status opened), Tokens (+ expanded row), Pairs (+ pair list), Users (manual + wallet accounts),
Launch modes (+ legacy owner tools and admin test opened), Settings. Client-side navigation explore → coin → analytics → explore also checked.
