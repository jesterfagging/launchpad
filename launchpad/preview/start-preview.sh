#!/usr/bin/env bash
# Starts the sample-data preview of the Launchpad UI from this repository.
# Needs Node 22+. Open http://127.0.0.1:4173 (admin: /admin?mockSession=admin).
cd "$(dirname "$0")" && PORT="${PORT:-4173}" node server.mjs
