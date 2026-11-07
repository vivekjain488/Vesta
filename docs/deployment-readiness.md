# Deployment readiness

## Sepolia broadcast attempt, 2026-11-07

The `DeploySepoliaDemo.s.sol` broadcast failed: all twelve contract creations reverted, and calls to the resulting empty addresses did not configure anything. Do not use the predicted addresses in the failed broadcast record. Approximately 0.02355 Sepolia ETH was spent on gas. The generated deployment JSON was removed because it describes contracts that were never deployed.

The machine's Foundry build (1.7-era, April 2026) simulated pre-Glamsterdam gas rules. Sepolia activated Glamsterdam on October 6, 2026, including EIP-8037 state-creation repricing; live RPC estimates for the first deployments are about five times the old estimates. Use a Foundry release supporting Amsterdam, run a fresh chain-appropriate simulation, compare gas estimates with `eth_estimateGas`, and broadcast sequentially only after the deployer is adequately funded. A simulation using the previous Foundry version is not sufficient.

References: [Ethereum Foundation Sepolia upgrade announcement](https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement), [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037).

The retry used Foundry 1.9.0 with `--hardfork amsterdam`, a fixed maximum fee, and `--slow`. All 21 transactions confirmed successfully; their receipts report a combined fee of 0.015715710875836703 Sepolia ETH. `node scripts/verify-sepolia-demo.cjs` independently checked contract bytecode, owners, vault/wallet/gate wiring, registry count, and the disabled Flash and bridge settings. Addresses are in `contracts/deployments/sepolia-demo-11155111.json`.

This deployment is a test-only, zero-yield demo. An owner withdrawal required the recovery procedure described below; autonomous trading and cross-chain funding are not enabled. The app still contains local-chain-only helpers, so its active environment was not switched to the Sepolia deployment. The 0G ComputeTreasury is not deployed: the real 0G token conversion and cross-chain token route are still unverified. CCIP test token availability does not establish a route that funds native 0G inference.

The initial vaults passed deposit and redemption by a non-owner depositor on a fork of Sepolia. This did **not** cover the separate agent-owner withdrawal path. On 2026-11-07 a live owner deposit of 1 USDC ([transaction](https://sepolia.etherscan.io/tx/0x60933250f572941c266776fc2a7125f122c8c8b7dc19feafc868b179cf892689)) succeeded but redeem simulation reverted: the deployed wallet tries to approve the zero Flash spender on Circle USDC. After a fork rehearsal, the owner temporarily set the wallet's spender to itself, [redeemed](https://sepolia.etherscan.io/tx/0x7e175aec2718d86d34e81d9ca7e0018f36e7010f8f88461346e721f984446e41), then reset the spender to zero. All 20 USDC returned, with no shares or self-allowance left. **Do not deposit into the legacy Sepolia vaults** recorded in `sepolia-demo-11155111-legacy-unsafe.json`; owner withdrawals still revert with the spender disabled.

The corrected stack was redeployed on 2026-11-07. All 21 transactions confirmed, the three wallet bytecodes matched the corrected compiled source, and the onchain verifier passed. A real owner [deposit](https://sepolia.etherscan.io/tx/0x0bcf9708a57149071e260fcddd8e79688e131cfeb63f5890a2c2f7b7c0c523c3) and [redemption](https://sepolia.etherscan.io/tx/0x899f7864c7707cdc8ac28468b0adc8d98556e16debe401f1e8d61dae6d02e00b) of 1 USDC succeeded with Flash disabled, returning the wallet to 20 USDC and zero shares. The test put Atlas into withdrawal sleep as designed. The active addresses are in `sepolia-demo-11155111.json`; the deployment receipts are in `sepolia-demo-11155111-receipts.json`. Deployment gas cost was 0.015729971066088774 Sepolia ETH. Trading and the bridge remain disabled, the public app's deposit path is not enabled, and these unaudited contracts remain test-only.

Sepolia dashboard history starts at the actual deployment block and pages RPC log queries; the demo deployment declares execution disabled so a funded vault is not presented as an active agent.

The 0G Compute Router balance used by the API-key inference integration is separate from the direct-provider ledger addressed by `ComputeTreasury.fundLedger`. Funding that direct ledger cannot be presented as funding the Router. Select and verify the intended inference billing path before implementing automatic top-ups; see [0G's inference documentation](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference).

The checked-in `Deploy.s.sol` was written for a local demo and must not be broadcast to a public network unchanged. Deployment should be resumed once the target vault network, owner and funded deployer are chosen.

## Blocking integration issues

- `MODE=vault` now creates an `AaveV3Adapter` per vault and records each adapter address. A local mock isolation/deposit/withdrawal test passes. A fork of the Aave V3 Ethereum Sepolia USDC pool rejected a 100 USDC deposit with error 51 (supply cap exceeded); it is not usable for the demo while the cap is full. Aave’s test USDC also differs from Circle’s Sepolia USDC.
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

Chainlink marks the old 0G Galileo selector `2131427466778448014` (chain 16601) deprecated. Galileo 1 (chain 16602) uses selector `6892437333620424805`; verify current source/destination lane and router before configuring it. The public-network deployment script now requires an explicit selector instead of defaulting to the deprecated value.
