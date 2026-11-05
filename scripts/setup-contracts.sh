#!/usr/bin/env bash
# Install pinned Solidity deps into contracts/lib (kept out of git).
set -euo pipefail
cd "$(dirname "$0")/../contracts"
mkdir -p lib
[ -d lib/forge-std ] || git clone -q --depth 1 --branch v1.9.6 https://github.com/foundry-rs/forge-std lib/forge-std
[ -d lib/openzeppelin-contracts ] || git clone -q --depth 1 --branch v5.1.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
forge build
