# Deployment readiness

The checked-in `Deploy.s.sol` was written for a local demo and must not be broadcast to a public network unchanged. Deployment should be resumed once the target vault network, owner and funded deployer are chosen.

## Blocking integration issues

- `MODE=vault` uses the same `SAFE_LEG_ADDRESS` for all three vaults. `AaveV3Adapter` has an immutable single `vault` and rejects calls from any other vault. Deploy and wire one adapter per vault, then verify deposit, accounting and withdrawal per vault on a fork before broadcasting.
- `DeployTreasury.s.sol` requires the source `HARVEST_ROUTER`, but `Deploy.s.sol` requires the destination `COMPUTE_TREASURY_ADDRESS` before deploying the source router. Use a staged deployment with an initially disabled cross-chain configuration, then wire and verify both sides after their addresses are known.
- The scripts do not deploy or wire `StrategyHire` or `HireReceiver`. The supported CCIP lane, source and destination token addresses, actual 0G conversion path and per-agent payout addresses must be verified before enabling a hire plan or routing funds.
- A funded public-chain deployer, distinct non-default proposer and price signer, real CCIP router, token addresses, swap adapter, safe-leg pool and Flash settlement spender must be configured. Never use Anvil private keys for public-chain roles. Verify every contract's bytecode, chain ID and token decimals on the selected networks.
- The hosted worker disables live execution pending per-agent compute funding and execution reconciliation; deploying contracts does not enable autonomous trading. The Flash integration currently supports a manual Base mainnet limit-order preview and Flash does not list Base Sepolia as a supported trading network.

## Before a broadcast

1. Confirm the chain and intended ownership/admin addresses; check gas balances and budget on each destination.
2. Validate the CCIP source/destination lane and token pool against the current Chainlink directory. A test token such as CCIP-BnM is not 0G and cannot fund 0G inference.
3. Resolve and simulate the staged deployment and per-vault adapters, including a real deposit/withdrawal path and replay protection. Run the tests and a dry-run on the selected network.
4. Broadcast, inspect receipts and bytecode, verify owner/role/configuration reads, then record chain-specific addresses and transaction hashes. Only switch app environment settings after those checks pass.

References: [Chainlink testnet directory](https://docs.chain.link/ccip/supported-networks/testnet), [0G Galileo network details](https://docs.0g.ai/developer-hub/testnet/testnet-overview), [Flash supported networks](https://flash.definitive.fi/docs/for-agents).
