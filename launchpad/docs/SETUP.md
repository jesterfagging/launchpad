# Running your launchpad on a server

This guide puts the launchpad online at your own domain: one Ubuntu server, Node.js, Caddy for HTTPS and a systemd
service. Commands are run on the server over SSH unless a step says otherwise.

## What you need

- A VPS with Ubuntu 24.04, 2 CPU cores and 4 GB of memory or more (8 GB if you turn on many launch modes).
- A domain, with an **A record** pointing at the server's IPv4 address (for example `launch.example.com`).
- A paid **Solana RPC** endpoint (Helius, QuickNode, Triton or similar). The public endpoint is too slow.
- A **Jupiter API key** from https://portal.jup.ag (swaps, prices and fee conversions).
- A Solana wallet you control for the platform's revenue (an address only; never put a seed phrase on the server).

## 1. Prepare the server

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl unzip git debian-keyring debian-archive-keyring apt-transport-https
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
# Caddy (HTTPS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
# Firewall: SSH and the web only
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
```

## 2. Install the app

```bash
sudo useradd --system --home /opt/launchpad --shell /usr/sbin/nologin launchpad
sudo mkdir -p /opt/launchpad/app /opt/launchpad/data /opt/launchpad/telegram-data
# Put the code in /opt/launchpad/app: git clone your fork, or upload the zip and unzip it there.
sudo git clone https://github.com/YOUR-ACCOUNT/YOUR-REPO.git /opt/launchpad/app
cd /opt/launchpad/app && sudo npm ci --omit=dev
sudo chown -R launchpad:launchpad /opt/launchpad
sudo chmod 700 /opt/launchpad/data /opt/launchpad/telegram-data
```

## 3. Settings

```bash
sudo cp /opt/launchpad/app/.env.example /etc/launchpad.env
sudo chmod 600 /etc/launchpad.env
sudo nano /etc/launchpad.env
```

Set at least:

| Setting | Value |
|---|---|
| `LAUNCHPAD_PUBLIC_URL` | `https://launch.example.com` (your domain) |
| `LAUNCHPAD_DATA_DIR` | `/opt/launchpad/data` |
| `LAUNCHPAD_PUBLIC_RPC_URL` | your Solana RPC URL |
| `LAUNCHPAD_PUBLIC_JUPITER_KEY` | your Jupiter key |
| `LAUNCHPAD_BRAND_NAME` | your launchpad's name |

Check the configuration (it reads the settings only; it sends nothing):

```bash
cd /opt/launchpad/app && sudo bash -c 'set -a; . /etc/launchpad.env; set +a; node scripts/check-readiness.mjs'
```

## 4. Start the service

```bash
sudo cp /opt/launchpad/app/deploy/launchpad.service /etc/systemd/system/launchpad.service
sudo systemctl daemon-reload
sudo systemctl enable --now launchpad
sudo systemctl status launchpad        # should say "active (running)"
```

## 5. HTTPS with Caddy

Replace `/etc/caddy/Caddyfile` with (your domain on the first line):

```
launch.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl restart caddy
```

Open `https://launch.example.com`. The first visit can take a few seconds while Caddy gets the certificate.

## 6. The admin account

Create the owner account with a username and password (this one command allows password accounts; the site itself
stays wallet-only):

```bash
sudo systemd-run --pty --wait --collect --uid=launchpad \
  --property=WorkingDirectory=/opt/launchpad/app --property=EnvironmentFile=/etc/launchpad.env \
  --setenv=LAUNCHPAD_ENABLE_MANAGED_ACCOUNTS=1 /usr/bin/node /opt/launchpad/app/scripts/setup-owner.mjs
```

Then on the website:

1. **Connect wallet** → **Recover an existing account** → the username and password you just chose.
2. Open your account → **Security** → turn on two-factor sign-in (an authenticator app). Save the recovery codes.
3. Link your wallet so you can sign in with it next time.
4. Open `https://launch.example.com/admin`.

## 7. First steps in the admin panel

- **Fee collection**: the wallet that receives the platform's share of fees, and the launch fee policy.
- **Treasury** (optional): a dedicated wallet that converts the platform's revenue to SOL and, with a platform token,
  buys it back and burns it. The Treasury section shows its setup command; it runs on the server like step 6.
- **Gas refills** (optional): a separate wallet that pays network fees for automatic reward payouts; its section
  shows its setup command too.
- **Venues**: the Pump.fun, Meteora, PumpSwap and Robinhood Chain sections switch those venues on. Pump.fun, AI Agents,
  transfer hooks and Robinhood Chain need their settings first (the example files in `deploy/`).
- **Platform branding**: updates the onchain platform name and logo of existing Raydium launches after a rename.

Launch a small test coin with a little SOL, buy and sell it, and check the coin page before you share the site.

## Everyday commands

| What | Command |
|---|---|
| Status | `sudo systemctl status launchpad` |
| Live log | `sudo journalctl -u launchpad -f` |
| Restart | `sudo systemctl restart launchpad` |
| Change settings | `sudo nano /etc/launchpad.env`, then restart |

## Updates

```bash
cd /opt/launchpad/app
sudo -u launchpad git pull          # or unzip the new version over the old one
sudo npm ci --omit=dev && sudo chown -R launchpad:launchpad /opt/launchpad/app
sudo systemctl restart launchpad
```

The service finishes the transactions it has in flight before it stops; give it up to two minutes.

## Backups

`/opt/launchpad/data` holds every account, launch record and encrypted wallet key, and `master.key` (the key that
decrypts them). Losing it loses access to those wallets. Copy it somewhere private regularly:

```bash
sudo tar -czf /root/launchpad-data-$(date +%F).tgz -C /opt/launchpad data
```

Keep the archive and `/etc/launchpad.env` off any public place, and never commit them to git.
