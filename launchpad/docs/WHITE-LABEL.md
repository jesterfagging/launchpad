# White-label mode

White-label mode turns one host into one branded launchpad described by a settings file, `tenant.json`: its name,
logo, colours, layout, fonts, the venues and launch modes it offers and the community features it switches on. It is
the same engine as the standard mode with a different skin and a narrower menu. Run one host (one service, one data
folder, one domain) per launchpad.

What changes compared with the standard mode:

- The name, logo, colours and footer links come from `tenant.json` and `brand/` (`LAUNCHPAD_BRAND_NAME`,
  `LAUNCHPAD_X_URL` and the platform token settings are not used).
- Only the venues, launch modes and Raydium/Meteora starts listed in the file are offered. The server refuses anything
  else, whatever the browser sends.
- Paycheck, Gotchi and AI Agent are not offered.
- Protocol fees always go to a treasury wallet the server creates on first start. It converts revenue to SOL; the owner
  withdraws it from **Admin → Revenue → Treasury** (two-factor sign-in required). An optional platform share of that
  revenue can be paid automatically to a hosting wallet (see below).

## 1. Make the folder

Put the settings and the artwork in a folder the service user can read, for example `/opt/launchpad/pad`:

```
/opt/launchpad/pad/
  tenant.json
  brand/
    logo-512.png    512 × 512 PNG, the logo (also the onchain platform image)
    icon-64.png     64 × 64 PNG, the browser tab icon
    icon-180.png    180 × 180 PNG, the phone home-screen icon
    hero.jpg        optional 1600 × 560 banner on the home page (shown when "look.hero" is true)
```

The three PNGs go together: without all three, the site draws a letter mark in your accent colour instead.

## 2. Write tenant.json

```json
{
  "version": 1,
  "name": "Moon Pad",
  "slug": "moonpad",
  "tagline": "Launch a coin in one review.",
  "layout": "rack",
  "preset": "ocean",
  "theme": "dark",
  "look": { "font": "rounded", "corners": "round", "background": "dots", "hero": false },
  "features": { "tickerLock": true, "bundleCheck": true, "registry": true, "summit": true, "takeover": false },
  "venues": ["pump-classic", "raydium", "meteora"],
  "modes": ["creator", "holders", "earned"],
  "hooks": false,
  "starts": { "raydium": ["20k", "4k"], "meteora": ["20k"] },
  "links": { "x": "@moonpad", "telegram": "t.me/moonpad", "website": "https://moonpad.example" },
  "poweredBy": false
}
```

| Field | Values |
|---|---|
| `version` | Always `1`. |
| `name` | 2 to 24 characters: letters, numbers, spaces and `. ' & ! _ -`. Shown on every page and onchain. |
| `slug` | 3 to 24 lowercase letters, numbers or single hyphens. A short id for the launchpad (used in the onchain platform record). |
| `tagline` | Optional, up to 80 characters, no `<` or `>`. |
| `layout` | `terminal` (dense trading look), `rack` (rounded, with a dock on phones), `clean` (airy, flat) or `arcade` (chunky outlines, hard shadows). |
| `preset` | A colour preset: `ultraviolet`, `tangerine`, `ocean`, `emerald`, `rose`, `crimson`, `gold`, `aqua`, `lime`, `volt`, or `custom` with `"accent": "#7C4DFF"`. |
| `theme` | `dark` or `light`. |
| `look.font` | `layout` (the layout's own), `grotesk`, `clean`, `rounded`, `poster` or `mono`. |
| `look.corners` | `layout`, `round`, `soft` or `sharp`. |
| `look.background` | `plain`, `dots`, `grid`, `glow` or `stars`. |
| `look.hero` | `true` shows `brand/hero.jpg` on top of the home page. |
| `features` | Each `true` or `false` (see the next table). |
| `venues` | One or more of `pump-classic` (Pump.fun), `raydium` (LaunchLab) and `meteora` (Dynamic Bonding Curve). |
| `modes` | One or more of `creator`, `holders` (every venue), and `diamond_hands`, `earned`, `insured`, `market_maker`, `lp_manager` (Pump.fun only). Every venue needs at least one mode it supports. |
| `hooks` | `true` offers transfer-hook rules on Meteora coins (needs Meteora and `LAUNCHPAD_HOOK_PROGRAM_ID`). |
| `starts` | For `raydium` and `meteora`: `["20k"]`, `["4k"]` or both (then the creator picks). Both graduate at a $50,000 market cap. Default `["20k"]`. |
| `links` | Optional X handle or link, Telegram link and website (https). Shown in the footer. |
| `poweredBy` | `true` shows "Powered by" in the footer when `launcher` is set (below). |
| `launcher` | Optional `{ "name": "Your Platform", "url": "https://platform.example" }`: who hosts the launchpad, for the footer and the treasury page. |

Features:

| Feature | What it does |
|---|---|
| `tickerLock` | A ticker or name cannot be launched again for 3 days, nor while that coin is active. Lookalikes and copied images are allowed but flagged on the coin page. |
| `bundleCheck` | Shortly after launch, early buyers are traced to the wallets that funded them; ones linked to the creator are flagged. |
| `registry` | Every launch is numbered (the first 100 are marked Founding), with a Launches page and a Stats page. |
| `summit` | One coin in the spotlight each day, drawn at random with odds weighted by market cap, volume and age. |
| `takeover` | Holders of 0.5% or more of a coin can ask for a new logo, banner, links and description; the owner approves. |

The file is checked when the service starts. If something is wrong, the service stops and the log
(`sudo journalctl -u launchpad -n 50`) says which field.

## 3. Settings

Follow [SETUP.md](SETUP.md) for the server, then add to `/etc/launchpad.env`:

```bash
LAUNCHPAD_PRODUCT=tenant
LAUNCHPAD_TENANT_FILE=/opt/launchpad/pad/tenant.json
```

Venues still need their own settings: Pump.fun needs `LAUNCHPAD_PUMP_CLASSIC_ENABLED=1`
(`deploy/launchpad-pump-classic.env.example`) and transfer hooks need `LAUNCHPAD_HOOK_PROGRAM_ID`
(`deploy/launchpad-hooks.env.example`). Raydium needs only the RPC and Jupiter settings. Meteora is set up by the
server and switched on once its managed wallet holds 0.1 SOL; **Admin → Meteora** shows the address to fund.

Make the folder readable by the service and restart:

```bash
sudo chown -R launchpad:launchpad /opt/launchpad/pad
sudo systemctl restart launchpad
```

On its first start the service creates the treasury wallet and makes it the protocol fee recipient. Create the owner
account exactly as in [SETUP.md, step 6](SETUP.md#6-the-admin-account).

To change anything later, edit `tenant.json` or the images and restart the service.

## Hosting launchpads for other people (optional)

If you run launchpads for clients, two settings make that part of the terms:

| Setting | What it does |
|---|---|
| `LAUNCHPAD_PLATFORM_SHARE_WALLET` | Your wallet. A share of the launchpad's SOL revenue accrues to it and is paid automatically. Leave it empty for no share. |
| `LAUNCHPAD_PLATFORM_SHARE_BPS` | The share in basis points, 1 to 5000. Default 1000 (10%). |
| `LAUNCHPAD_PLATFORM_SHARE_MIN_LAMPORTS` | The smallest payout. Default 50000000 (0.05 SOL). |
| `LAUNCHPAD_TENANT_STATUS_KEY` | A random key of 32 characters or more. With it, `GET /api/internal/launchpad` with the header `x-launchpad-key: <key>` returns the launchpad's name, venues, coin and account counts and treasury totals. Without it the address answers 404. |

The launchpad's owner sees the share on the treasury page and cannot switch it off. Make a status key with
`openssl rand -hex 32`, and block `/api/internal/` at your reverse proxy if only your own systems should reach it.

For automated set-ups, `scripts/tenant-provision.mjs` creates the owner account from a username and a password hash
(made with `src/password-hash.mjs`) read on stdin, so no password passes through your provisioning system; see the
comment at the top of the script.
