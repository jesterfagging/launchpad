# Security

## Reporting a vulnerability

Please report security problems privately through this repository's security advisories (**Security → Report a
vulnerability**), not in a public issue. Include the steps to reproduce and the version or commit you tested.

## What the server holds

Visitors sign with their own wallets; the launchpad never holds their keys or balances. The server does operate some
wallets of its own and keeps their keys encrypted in the data folder:

- each launch's managed wallets (rewards, fee routing and the like, depending on the launch mode),
- the protocol treasury and the gas wallet, when you set them up,
- the Meteora authority and, in white-label mode, the launchpad treasury.

`master.key` in the data folder (or `LAUNCHPAD_MASTER_KEY_FILE`) decrypts them. Anyone with the data folder **and**
that key controls those wallets. Anyone who loses them loses those wallets.

## Before you go live

- Run the service as its own user with the shipped systemd unit (`deploy/launchpad.service`); it can write only its
  data folders.
- Keep `LAUNCHPAD_BIND_ADDRESS=127.0.0.1` and put Caddy or nginx with HTTPS in front. Open only ports 22, 80 and 443.
- `chmod 600 /etc/launchpad.env` and `chmod 700` on the data folder. Never commit either to git (`.gitignore` already
  excludes `.env`, `master.key` and the data folders).
- Turn on two-factor sign-in for every administrator. The admin panel refuses administrators without it.
- Use SSH keys, not passwords, for the server, and keep it updated (`sudo apt update && sudo apt upgrade`).
- Leave the trading toolkit, Telegram bot and password accounts off (`LAUNCHPAD_ENABLE_TOOLKIT`,
  `LAUNCHPAD_ENABLE_TELEGRAM`, `LAUNCHPAD_ENABLE_MANAGED_ACCOUNTS`) unless you need them; they add attack surface.
- Back up the data folder and the key to an encrypted place that is not on the server, and test a restore.
- Fund operating wallets (gas, Meteora authority, treasury) with what they need for a few days, not more.
- Rotate your RPC and Jupiter keys if they ever appear in a log, a screenshot or a chat.

## Programs and contracts

The Solana programs and Robinhood Chain contracts in `contracts/` have not had a professional audit. Read
[docs/PROGRAMS.md](docs/PROGRAMS.md) before deploying any of them, test with small amounts first, and consider an
independent review.

## No warranty

The software is provided as is, under the MIT license, without warranty of any kind. You are responsible for how you
run it and for the laws that apply to a token launchpad where you and your users are.
