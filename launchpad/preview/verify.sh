#!/usr/bin/env bash
# Shoot every verified route into shots/. Requires ./ctl.sh start first.
# Usage: ./verify.sh [filter-regex]   e.g. ./verify.sh admin
cd "$(dirname "$0")"
OTTER=56rHmw6WonvGiumJRwhNPJ659x9tKhGF2utn35kYNVDV   # Raydium, on curve, creator fees
HARBR=3saPKZ98mDiY728bop5BUBHtQThz2kBosxFtfpZHiesf   # Meteora, holder rewards (USDC)
CROW=DS8tQLnGJFXgAm5CfHj4p9XmVrUHBL9gvpu6Fd6xe4sr    # Raydium, agent buyback
KOI=EDSNFaCBnmYjVqv5LG9c7QVxUFfs8tbeEvZKKTADEhSD     # PumpSwap launch mode (damm-pump)
GRID=6H9Skjwo1h71K5PF5ZgdCe9bvdvM9wRbDSTLz2HryuK9    # Raydium, graduated (DEX Screener iframe)
GOAT=7tQfDSYcXDpAssin1VG7j7v2G5ySUyL6K1L3LQ8QYVEz   # Raydium, Gotchi (Fomogotchi), on curve
LEMON=46ak7mJxerw9jUbW7j6KMjSTfEUufzHjRSwGrvLuKj5Y  # Raydium, Gotchi (Fomogotchi), graduated, USDC quote
SCOUT=$(node -e "import('./mocks/data.mjs').then(m=>console.log(m.coins().find(c=>c.symbol==='SCOUT').mint))")   # Raydium, AI Agent (ready)
TIDE=$(node -e "import('./mocks/data.mjs').then(m=>console.log(m.coins().find(c=>c.symbol==='TIDE').mint))")     # Meteora, AI Agent (sleeping)
OTTER_LAUNCH=$(node -e "console.log(require('crypto').createHash('sha256').update('launch:OTTER').digest('hex').slice(0,32))")
SHOTS=(
  "explore|/|--full"
  "explore-mobile|/|--mobile --full"
  "explore-graduated|/|--full --click=button[data-explore-stage=graduated]"
  "explore-search|/|--click=#explore-search --type=o"
  "coin-otter|/coin?mint=$OTTER|--full"
  "coin-otter-holders|/coin?mint=$OTTER|--full --click=[data-activity=holders]"
  "coin-harbr-holders-rewards|/coin?mint=$HARBR|--full"
  "coin-crow-buyback|/coin?mint=$CROW|--full"
  "coin-koi-pumpswap|/coin?mint=$KOI|--full"
  "coin-grid-graduated|/coin?mint=$GRID|--full"
  "coin-official|/coin?mint=7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc|--full"
  "coin-otter-mobile|/coin?mint=$OTTER|--mobile --full"
  "launchpad-anon|/launchpad|--full"
  "launchpad-user|/launchpad|--full --session=user"
  "launchpad-user-meteora|/launchpad|--full --session=user --click=[data-launch-venue=meteora]"
  "launchpad-user-pumpswap|/launchpad?venue=damm-pump|--full --session=user"
  "analytics|/analytics|--full"
  "creator|/creator?username=mira_builds|--full"
  "launched-tokens-anon|/launched-tokens|--full"
  "launched-tokens-user|/launched-tokens|--full --session=user"
  "launched-tokens-detail-user|/launched-tokens?id=$OTTER_LAUNCH|--full --split=1600 --session=user"
  "launched-tokens-drafts-user|/launched-tokens|--full --session=user --click=[data-launch-filter=drafts]"
  "wallet-account-anon|/wallet-account|--full"
  "wallet-account-user|/wallet-account|--full --session=user"
  "docs|/docs|--full"
  "terms|/terms|"
  "privacy|/privacy|"
  "admin-anon|/admin|"
  "admin-user|/admin|--session=user"
  "admin-overview|/admin|--full --session=admin --hash=overview"
  "admin-revenue|/admin|--full --split=1600 --session=admin --hash=revenue"
  "admin-revenue-checks|/admin|--full --session=admin --hash=revenue/checks"
  "admin-revenue-diagnostics|/admin|--full --session=admin --hash=revenue/diagnostics"
  "admin-tokens|/admin|--full --session=admin --hash=tokens"
  "admin-tokens-expanded|/admin|--full --session=admin --hash=tokens --click=.launch-admin-row>summary"
  "admin-pairs|/admin|--full --session=admin --hash=pairs --click=.admin-pairs-catalog>summary"
  "admin-users|/admin|--full --session=admin --hash=users"
  "admin-users-wallet|/admin|--full --session=admin --hash=users --click=#admin-users-wallet"
  "admin-launch-modes|/admin|--full --session=admin --hash=pump-test"
  "admin-launch-modes-legacy|/admin|--full --split=1600 --session=admin --hash=pump-test/legacy"
  "admin-launch-modes-meteora|/admin|--full --session=admin --hash=pump-test/meteora"
  "admin-settings|/admin|--full --session=admin --hash=settings"
  "gotchi-list|/gotchi|--full"
  "gotchi-list-mobile|/gotchi|--mobile --full"
  "gotchi-fomo|/gotchi?id=fomogotchi|--full"
  "gotchi-fomo-user|/gotchi?id=fomogotchi|--full --session=user"
  "gotchi-pump|/gotchi?id=pumpgotchi|--full"
  "gotchi-fomo-mobile|/gotchi?id=fomogotchi|--mobile --full"
  "coin-goat-gotchi|/coin?mint=$GOAT|--full"
  "coin-lemon-gotchi-graduated|/coin?mint=$LEMON|--full"
  "launchpad-user-gotchi|/launchpad|--full --session=user --click=label:has(input[value=gotchi])"
  "launchpad-user-gotchi-meteora|/launchpad|--full --session=user --click=[data-launch-venue=meteora] --click=label:has(input[value=gotchi])"
  "admin-gotchi|/admin|--full --split=1600 --session=admin --hash=tokens/gotchi"
  "agents-list|/agents|--full"
  "agents-list-mobile|/agents|--mobile --full"
  "coin-scout-agent|/coin?mint=$SCOUT|--full --hash=agent"
  "coin-scout-agent-user|/coin?mint=$SCOUT|--full --hash=agent --session=user"
  "coin-scout-agent-treasury|/coin?mint=$SCOUT|--hash=agent --click=[data-agent-tab=treasury] --selector=.coin-agent"
  "coin-scout-agent-activity|/coin?mint=$SCOUT|--hash=agent --click=[data-agent-tab=activity] --selector=.coin-agent"
  "coin-tide-agent-meteora|/coin?mint=$TIDE|--full --hash=agent"
  "coin-scout-agent-mobile|/coin?mint=$SCOUT|--mobile --full --hash=agent"
  "launchpad-user-agent|/launchpad|--full --session=user --click=label:has(input[value=agent])"
  "launchpad-user-agent-meteora|/launchpad|--full --session=user --click=[data-launch-venue=meteora] --click=label:has(input[value=agent])"
  "admin-agents|/admin|--full --split=1600 --session=admin --hash=tokens/agents"
)
fail=0
for entry in "${SHOTS[@]}"; do
  IFS='|' read -r name path opts <<< "$entry"
  [[ -n "$1" && ! "$name" =~ $1 ]] && continue
  echo "=== $name"
  # Options are space-separated; write a literal space inside one option as "_" (e.g. --click=a_b).
  read -r -a argv <<< "$opts"; argv=("${argv[@]//_/ }")
  node shoot.mjs "$path" "shots/$name.png" "${argv[@]}" | sed 1d; [ "${PIPESTATUS[0]}" = 0 ] || fail=1
done
echo; echo "Server log (unmocked API / asset-map warnings):"; grep -E 'UNMOCKED|NOT-IN-REAL|\[404\]|error' server.log | sort | uniq -c | grep . || echo "  none"
exit $fail
