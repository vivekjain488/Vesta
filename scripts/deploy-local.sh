#!/usr/bin/env bash
# Deploy the full Perpetua stack to a local anvil (start one first: `anvil`).
# Uses anvil's well-known dev keys ONLY. Never reuse these anywhere real.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
RPC=${VAULT_RPC_URL:-http://127.0.0.1:8545}
DEP=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0: deployer + sim Flash spender
PROP=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d  # anvil #1: agent proposer + price signer
TEE=$(cast wallet address --private-key "$(cast keccak perpetua-sim-tee-signer)")  # SimBrain's TEE signer
RULES=$(cast wallet address --private-key "${RULES_SIGNER_PRIVATE_KEY:-$(cast keccak perpetua-local-rules-signer)}")  # deterministic-rules attester
mkdir -p deployments
rm -rf broadcast/Deploy.s.sol/31337 cache/Deploy.s.sol/31337   # fresh local chain each time
DEPLOYER_PRIVATE_KEY=$DEP \
PROPOSER_ADDRESS=$(cast wallet address --private-key $PROP) \
PRICE_SIGNER_ADDRESS=$(cast wallet address --private-key $PROP) \
TEE_SIGNER_ADDRESS=$TEE \
RULES_SIGNER_ADDRESS=$RULES \
FLASH_SPENDER_ADDRESS=$(cast wallet address --private-key $DEP) \
MODE=local CCIP_AUTO_DELIVER=true LENDING_TIME_MULTIPLIER=${LENDING_TIME_MULTIPLIER:-1} \
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast -j 2 >/dev/null
ROUTER=$(python3 -c "import json;print(json.load(open('deployments/local-31337.json'))['harvestRouter'])")
cast send "$ROUTER" --value 1ether --private-key $DEP --rpc-url "$RPC" >/dev/null   # CCIP fee gas (counted as burn)
echo "deployed -> contracts/deployments/local-31337.json"
