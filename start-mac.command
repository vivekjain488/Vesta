#!/bin/bash
# Local Perpetua launcher. Double-click in Finder or run ./start-mac.command.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")"
ROOT="$PWD"
LOGS="$ROOT/.perpetua/logs"
STATE="$ROOT/.perpetua/anvil-state.json"
DEPLOYMENT="$ROOT/contracts/deployments/local-31337.json"
mkdir -p "$LOGS"
ANVIL_PID=""; API_PID=""; WEB_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo "Stopping services started by this launcher..."
  for pid in "$WEB_PID" "$API_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill -INT "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
    echo "Local chain saved to $STATE"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for cmd in node pnpm anvil forge cast curl python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing $cmd. Install Node.js 22.13+, pnpm and Foundry, then run this script again."
    exit 1
  fi
done
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)'; then
  echo "Node.js 22.13 or newer is required."
  exit 1
fi
if [ ! -x node_modules/.bin/tsx ] || [ ! -f frontend/node_modules/next/dist/bin/next ]; then
  echo "Installing project dependencies (first run)..."
  pnpm install --frozen-lockfile
fi
if [ ! -f contracts/out/PerpetuaVault.sol/PerpetuaVault.json ] || [ ! -d contracts/lib/forge-std ] || [ ! -d contracts/lib/openzeppelin-contracts ]; then
  echo "Preparing local contracts (first run)..."
  pnpm setup:contracts
fi

port_used() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
wait_http() {
  local url="$1" pid="$2" label="$3" i=0
  while [ "$i" -lt 90 ]; do
    if curl -s -o /dev/null --max-time 2 "$url"; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then echo "$label stopped during startup. Check $LOGS."; return 1; fi
    sleep 1; i=$((i + 1))
  done
  echo "$label did not become ready. Check $LOGS."; return 1
}

if port_used 8545; then
  client=$(cast rpc --rpc-url http://127.0.0.1:8545 web3_clientVersion 2>/dev/null || true)
  if [[ "$client" != *anvil* && "$client" != *Anvil* ]] || [ "$(cast chain-id --rpc-url http://127.0.0.1:8545 2>/dev/null || true)" != 31337 ]; then
    echo "Port 8545 is occupied by something other than local Anvil (chain 31337). Stop it or use another setup."
    exit 1
  fi
  echo "Using the existing local Anvil chain."
else
  if [ -f "$DEPLOYMENT" ] && [ ! -f "$STATE" ]; then
    echo "Existing deployment found, but its Anvil chain is not running and no saved chain state exists."
    echo "Start the original chain or deliberately set up a fresh local deployment; no files were reset."
    exit 1
  fi
  echo "Starting local Anvil..."
  anvil --host 127.0.0.1 --port 8545 --state "$STATE" --state-interval 30 >"$LOGS/launcher-anvil.log" 2>&1 & ANVIL_PID=$!
  i=0
  until cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; do
    if ! kill -0 "$ANVIL_PID" 2>/dev/null || [ "$i" -ge 30 ]; then echo "Anvil failed to start; check $LOGS/launcher-anvil.log"; exit 1; fi
    sleep 1; i=$((i + 1))
  done
fi
if [ ! -f "$DEPLOYMENT" ]; then
  echo "Deploying local test contracts..."
  VAULT_RPC_URL=http://127.0.0.1:8545 pnpm deploy:local
else
  usdc=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["usdc"])' "$DEPLOYMENT")
  code=$(cast code "$usdc" --rpc-url http://127.0.0.1:8545)
  if [ "$code" = "0x" ]; then
    echo "The current Anvil chain does not contain the saved deployment. No files were reset."
    exit 1
  fi
fi

if port_used 8787; then
  if ! curl -s --max-time 3 http://localhost:8787/auth/session | python3 -c 'import json,sys; x=json.load(sys.stdin); sys.exit(0 if x.get("error")=="Sign in with MetaMask" or "address" in x else 1)' 2>/dev/null; then
    echo "Port 8787 is occupied by an unrecognized service. Stop it and retry."; exit 1
  fi
  echo "Using the existing Perpetua API on port 8787; its configuration may differ from this launcher."
else
  echo "Starting the API and local simulation worker..."
  FLASH_MODE=sim ZG_MODE=sim INFERENCE_PROVIDER=0g CANDLE_SOURCE=synthetic HOSTED_RUNTIME_ENABLED=false CONFIG_COMPILER_ENABLED=false \
    VAULT_RPC_URL=http://127.0.0.1:8545 VAULT_CHAIN_ID=31337 DEPLOYMENT_FILE="$DEPLOYMENT" APP_ORIGIN=http://localhost:3000 API_PORT=8787 \
    FLASH_SPENDER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
    PROPOSER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
    PRICE_SIGNER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
    node --import tsx api/src/server.ts >"$LOGS/launcher-api.log" 2>&1 & API_PID=$!
  wait_http http://localhost:8787/auth/session "$API_PID" API
fi
if port_used 3000; then
  if ! curl -sf --max-time 3 http://localhost:3000/ | grep -i perpetua >/dev/null; then echo "Port 3000 is occupied by an unrecognized service. Stop it and retry."; exit 1; fi
  echo "Using the existing website on port 3000; restart that service to load newer frontend changes."
else
  echo "Starting the website..."
  (cd frontend && NEXT_PUBLIC_API_URL=http://localhost:8787 node node_modules/next/dist/bin/next dev -p 3000) >"$LOGS/launcher-web.log" 2>&1 & WEB_PID=$!
  wait_http http://localhost:3000/ "$WEB_PID" Website
fi
printf '\nPerpetua is available at http://localhost:3000\n'
echo "Launcher-started trading, market prices, and 0G inference use local simulation; live deposits and trading are disabled."
echo "Logs: $LOGS/launcher-{anvil,api,web}.log"
echo "Keep this window open. Press Ctrl+C to stop services started by this script."
if command -v open >/dev/null 2>&1; then open http://localhost:3000; fi
while :; do
  for pid in "$ANVIL_PID" "$API_PID" "$WEB_PID"; do
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "A service stopped. Check the launcher logs."; exit 1; fi
  done
  sleep 3
done
