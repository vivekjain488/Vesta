# Run and inspect VESTA locally

## Current integration status

The frontend, API, Anvil and supervised market mirror are already running in the current session. Open **http://localhost:3000**. Product data requires MetaMask sign-in.

The market publisher reads live Binance USDⓈ-M futures data, writes confirmed snapshots to Arkiv Rabdi, and exposes them through authenticated API reads and exported backend readers. This is live and independently verified. The running trading configuration currently uses `FLASH_MODE=sim`, `CANDLE_SOURCE=synthetic` and `ZG_MODE=router`. Therefore the agent does **not** currently trade from the live mirror. The configured 0G testnet Router is unreachable, and the prepared direct compute wallet is still unfunded. Saving an API key has not completed a paid live inference.

There are two useful paths below. A complete local product exercise uses simulated inference and deterministic market data. The independent Arkiv market mirror remains live in either mode.

## Exercise the wallet-to-withdrawal flow

1. Keep the existing Anvil process running on port 8545. Stop the existing API process on port 8787, then start the explicit local simulation from the repository root:

   ```sh
   pnpm api:sim
   ```

   This overrides AI/candle settings for that process only; it preserves the saved Router key, provider configuration and live market service. Stopping/restarting the API invalidates its in-memory login sessions, so sign in again.

2. Open **http://localhost:3000** and sign in with MetaMask. The signature logs you in; deposits require separate transaction confirmations.
3. Select **Create agent**, enter a name, choose **Spot accumulation**, and set **Assets** to `LINK`. Keep the initial operating minimum at 25 USDC and exposure at 100 USDC. Sign the strategy configuration. The API creates owner-bound local vault/wallet/gate contracts.
4. On the agent page click **Get test funds**. This adds 10,000 mock USDC and local gas to the connected wallet. It is a local-chain faucet; it does not fund Arkiv or 0G.
5. Enter `1000` under **Add capital** and approve both the token allowance and deposit in MetaMask. Allow the app to add/switch to **VESTA Local**, RPC `http://127.0.0.1:8545`, chain ID `31337`, currency `ETH`.
6. Watch **Current investments** and **Transaction history**. The backend worker runs with the page closed. Its first local accumulation opportunity should be evaluated shortly after funding; later checks follow the configured cadence. A check does not guarantee a trade. Cash, protected lending and any settled LINK holding are read from contracts.
7. Withdraw part of the LINK position, accepting possible loss and a minimum proceeds amount. Position settlement and the MetaMask payout are separate steps. You can also withdraw directly from cash or protected lending.
8. Try **Withdraw all**. It closes remaining token holdings and redeems every owner share, including protected lending. Confirm the wallet transaction. The portfolio should become empty and the agent should sleep. Partial withdrawals below the configured minimum also sleep it.
9. Create another agent to verify one wallet can own multiple independent allocations. The leaderboard shows names and cumulative profits; deposits never count as profit.

Natural-language **Generate strategy** requires working live 0G. It deliberately remains unavailable in simulation. Choose a template for this path. Futures templates cannot yet deploy to a real derivatives venue.

## Inspect the live Arkiv feed

The market mirror is installed as a separate macOS LaunchAgent and already running. Inspect it with:

```sh
pnpm market:service status
pnpm market:query BTCUSDT
pnpm market:query BTCUSDT candles
pnpm market:query BTCUSDT history
tail -f .perpetua/logs/market.stdout.log
```

Latest/history results contain entity keys, source timestamps, publication timestamps, writer identity and data. Query twice to see updates. Latest-state entity keys stay stable as their values update; historical sampling buckets receive distinct entities. Logs contain the actual Arkiv publication transaction hashes.

For readable service diagnostics:

```sh
node -e 'const s=require("./.perpetua/market-service-status.json"); console.log(JSON.stringify(s,null,2))'
```

After signing into the app, these URLs also return JSON in the same browser:

- `http://localhost:8787/v1/market/status`
- `http://localhost:8787/v1/market/BTCUSDT`
- `http://localhost:8787/v1/market/BTCUSDT/candles?limit=5`
- `http://localhost:8787/v1/market/BTCUSDT/history?limit=5`
- `http://localhost:8787/v1/network` — actual API execution, AI and candle modes, chain and wallet balance

Authenticated reads return 401 before login. The API's market data comes back from Arkiv; the diagnostic cache is not substituted for a successful chain read. The default universe is BTC/ETH/LINK USDT perpetuals. This is a sampled top-20 book/market mirror, not all exchanges or every trade. The service runs while the Mac is awake; see [market service operations](market-mirror.md) for always-on deployment and gas funding.

## Restart services later

Skip commands for services already running. In separate terminals, from the repository root:

```sh
# Terminal 1: only if the existing local chain has stopped
anvil --host 127.0.0.1 --port 8545

# Terminal 2: explicit complete local exercise
pnpm api:sim

# Terminal 3: UI with the existing production build
pnpm --filter @perpetua/frontend start

# Separate service; only if the installed market service is stopped
pnpm market:service start
```

For frontend code changes, stop its existing server and use `pnpm --filter @perpetua/frontend exec next dev --webpack --hostname 127.0.0.1 --port 3000`. Build a new production bundle with `pnpm --filter @perpetua/frontend exec next build --webpack` while the frontend server is stopped.

**Keep the current Anvil process alive to retain its chain state.** The present Anvil was started without a persistent state file. Restarting it produces a new chain even though old deployment/agent files remain. Do not run `pnpm deploy:local` as an ordinary app-start command: it replaces the deployment registry and is a fresh-chain setup/reset operation. If Anvil was reset, the old local agents need a deliberate state/deployment reset before trying the UI again.

## Automated local verification

With Anvil and `pnpm api:sim` running:

```sh
pnpm check:local
pnpm typecheck
pnpm --filter @perpetua/core test
pnpm test:contracts
```

The product check authenticates an isolated temporary wallet, verifies ownership isolation, deploys/funds an agent, waits for a settled local trade, performs a partial exit and full withdrawal, and checks protected redemption, sleep, history and leaderboard fields. It removes its temporary dashboard definitions afterward. Receipt evidence remains in `.perpetua/local-product-verification.json`. It checks the running API mode before creating anything, so accidentally pointing it at the real AI configuration does not consume inference credits.

## What remains for the intended live product

- **0G inference/compiler:** fund the prepared direct Galileo wallet `0xeC8e8d6459423230AeE6195289E6238a20728324` with 4 testnet 0G, then run `pnpm exec tsx agent/src/setup-testnet.ts --activate`. It creates the 3-token ledger plus provider setup, verifies a response and switches the saved mode only on success. Restart with `pnpm api`, without simulation overrides. Provider availability and verification are checked live.
- **Shared knowledge in the trading loop:** the candle adapter supports `CANDLE_SOURCE=arkiv`, but the currently running local execution setup intentionally uses synthetic prices. The full quote/book/funding mirror is available as a backend tool; it is not yet the complete knowledge input to every running agent. RiskGate execution checks still need fresh venue-specific prices after inference.
- **Live order execution:** Flash needs its API key and production signer/deployment configuration for spot. The current hosted deploy/withdraw worker only supports Anvil. A futures venue adapter with margin, reduce-only exits and settlement reconciliation is still required.
- **Proof integration:** Router verification metadata is not the raw signer-bound proof expected by RiskGate. Direct provider signer allowlists must also be configured for newly deployed contracts; old local seed gates authorize the simulation signer.
- **Agent history on Arkiv:** market data and the Signature Atlas are live. Per-agent runtime records still use the local outbox until funded per-agent writers are configured.
- **CCIP/self-funding:** the source/receiver contract path has a local simulator. A real supported lane, destination asset conversion and earnings-to-compute receipts remain necessary to demonstrate the sponsor money loop.
- **Hosting/isolation:** local services are single-process and not a production custody/deployment system. An always-on host, durable worker coordination, isolated agent credentials/ledgers and indexed history remain needed for live operation.
