#!/usr/bin/env bash
# Perpetua's Bee node (Swarm mainnet, Docker). Usage:
#   scripts/swarm-node.sh status            node mode, wallet, balances, stamps
#   scripts/swarm-node.sh setup [days]      after funding: light mode -> wait for chain sync -> buy a stamp ->
#                                            wait until usable -> write SWARM_BEE_URL / SWARM_POSTAGE_BATCH_ID to .env
# Funding (once): ~0.01 xDAI + ~0.2 xBZZ on Gnosis Chain to the node wallet printed by `status`
#   (gift code: swarm-cli utility redeem <KEY> --target <WALLET>; or https://fund.ethswarm.org).
set -euo pipefail
cd "$(dirname "$0")/.."
BEE=http://localhost:1633
NAME=perpetua-bee
IMAGE=ethersphere/bee:2.8.0
RPC=${SWARM_GNOSIS_RPC:-https://xdai.fairdatasociety.org}
XBZZ=0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da
PW_FILE=.perpetua/secrets/bee-password
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

run_node() { # $@: extra bee flags
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:1633:1633 -v perpetua-bee:/home/bee/.bee \
    -e BEE_PASSWORD="$(cat "$PW_FILE")" "$IMAGE" start --api-addr 0.0.0.0:1633 --full-node=false "$@" >/dev/null
  for _ in $(seq 1 60); do curl -sf "$BEE/health" >/dev/null && return 0; sleep 3; done
  echo "Bee did not come up; see: docker logs $NAME" >&2; return 1
}

status() {
  local w; w=$(curl -s "$BEE/addresses" | json 'd["ethereum"]')
  echo "mode:    $(curl -s "$BEE/node" | json 'd["beeMode"]')"
  echo "wallet:  $w  (Gnosis Chain)"
  echo "xDAI:    $(cast balance "$w" --rpc-url https://rpc.gnosischain.com -e)"
  echo "xBZZ:    $(python3 -c "print($(cast call $XBZZ 'balanceOf(address)(uint256)' "$w" --rpc-url https://rpc.gnosischain.com | cut -d' ' -f1)/1e16)")"
  curl -s "$BEE/stamps" 2>/dev/null | python3 -c "import sys,json
try:
  for s in json.load(sys.stdin).get('stamps',[]): print('stamp:  ', s['batchID'], 'usable', s['usable'], 'depth', s['depth'], 'ttl(s)', s['batchTTL'])
except Exception: pass"
}

setup() {
  local days=${1:-21}
  status
  echo "-> light mode (swap + chain RPC)"
  run_node --swap-enable --blockchain-rpc-endpoint "$RPC"
  echo "-> waiting for chain sync / chequebook (can take ~5 min)"
  for _ in $(seq 1 120); do
    local ready; ready=$(curl -s "$BEE/chainstate" | json '1 if int(d.get("currentPrice",0))>0 else 0' 2>/dev/null || echo 0)
    [ "$ready" = 1 ] && curl -sf "$BEE/wallet" >/dev/null && break; sleep 5
  done
  local price; price=$(curl -s "$BEE/chainstate" | json 'd["currentPrice"]')
  local amount=$(( price * 17280 * days ))
  echo "-> buying stamp: depth 17 (~40 KB-class batch, enough for JSON records), ${days} days, amount ${amount}"
  local batch; batch=$(curl -s -X POST "$BEE/stamps/${amount}/17" | json 'd["batchID"]')
  echo "   batch ${batch}; waiting until usable"
  for _ in $(seq 1 120); do
    [ "$(curl -s "$BEE/stamps/${batch}" | json 'str(d.get("usable")).lower()' 2>/dev/null)" = true ] && break; sleep 5
  done
  python3 - "$batch" <<'PY'
import sys, re
batch = sys.argv[1]
s = open(".env").read()
for k, v in (("SWARM_BEE_URL", "http://localhost:1633"), ("SWARM_POSTAGE_BATCH_ID", batch)):
    s = re.sub(rf"^{k}=.*$", f"{k}={v}", s, flags=re.M) if re.search(rf"^{k}=", s, re.M) else s.rstrip("\n") + f"\n{k}={v}\n"
open(".env", "w").write(s)
PY
  echo "-> .env updated (SWARM_BEE_URL, SWARM_POSTAGE_BATCH_ID). Next: pnpm swarm:demo"
  status
}

case "${1:-status}" in
  status) status ;;
  setup) shift; setup "$@" ;;
  *) echo "usage: $0 status|setup [days]" >&2; exit 1 ;;
esac
