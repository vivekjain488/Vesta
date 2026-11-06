# Configurable hosted agents

## Current local product

Open **http://localhost:3000**. MetaMask sign-in uses a domain-bound SIWE challenge, single-use signature verification and an HttpOnly session cookie. All `/v1` API routes require a session; dashboard, investment and history reads check wallet ownership. Logging out hides the application. Sessions are currently held in one API process and require another sign-in after restart. EOA MetaMask signatures are supported; contract-wallet authentication is not yet implemented.

One wallet can create multiple independent agents. Choose a strategy, name, assets, exposure/risk limits, minimum capital and model threshold. Sign the exact configuration. On Anvil the API deploys a separate vault, trading wallet and RiskGate, registers the agent and transfers ownership to the connected wallet. **Get test funds** adds 10,000 mock USDC and local gas. MetaMask signs approval and deposit. An agent's configuration is fixed after local deployment; another strategy requires another agent. Draft definitions remain independently editable with signed requests and optimistic revisions.

The API hosts local spot workers independently of browser sessions. Workers check all configured assets on the selected cadence (default 60 seconds), refresh risk limits and apply deterministic rules plus simulated AI before proposing orders. Local fills exercise actual mock-token transfers and contract allowance caps. An order acceptance alone is not a completed investment. Agents display actual balances and contract transaction history; the leaderboard response contains only **name and cumulative profit**. Profit is current NAV plus withdrawals minus deposits, so adding principal never counts as profit.

[Withdrawals and sleep](withdrawals.md) cover per-investment exits, protected lending and full redemption. The optional paid WebSocket subscription idea remains in [future scope](future-scope.md).

## Strategies and AI

`packages/core/src/agent-config.ts` defines a strict, versioned data schema shared by templates, browser edits and AI output. It rejects unknown fields, unsafe leverage and invalid risk/horizon combinations. Templates include spot momentum, spot range and accumulation, plus futures trend/range research. All use closed 4h candles. A 20–30 second execution delay is treated as a stale-observation and execution-cost constraint; no strategy promises to predict profitable prices 30 seconds ahead.

`POST /v1/strategy/compile` drafts schemas using a verified live 0G provider. It requires `CONFIG_COMPILER_ENABLED=true` and either Router API configuration or `ZG_MODE=live`, `ZG_PRIVATE_KEY` and `ZG_PROVIDER_SMALL` for the direct SDK. It reports unsupported requirements, never runs generated code and requires owner review before saving. Without that provider it returns an explicit unavailable response. The compiler has an operator-funded token budget; this is separate from an agent earning its inference costs.

Model choice uses allocated agent NAV and compute runway. Small eligible allocations use the small model; the default premium threshold is $5,000. Runway, token caps and daily observed spend can force a downgrade or skip inference. Spend is persisted locally; unknown settlement cost blocks further calls for that UTC day. The observed-spend cap is not a prepaid hard billing ceiling. Production needs pre-call reservations and verified provider settlement. Local inference uses `SimBrain`, synthetic prices and public Anvil execution keys.

## 0G Router and testnet setup

`ZG_MODE=router` uses the server-only `ZG_API_KEY`, `ZG_BASE_URL`, `ZG_MODEL_SMALL` and `ZG_MODEL_LARGE`. Mainnet and testnet Router balances/keys are separate. The Router client requests `verify_tee: true`, records returned request IDs and billing, requires a verified response for strategy drafts, and conservatively reserves tokens before network calls in persistent files. It does not blindly retry timed-out requests. A Router verification verdict is not a raw signer-bound proof that can authorize an on-chain RiskGate order. Router-based analysis can run, but order submission still requires that proof integration.

An inference `sk-` key cannot read Router account balances. Router mode therefore reports unknown runway instead of inventing a ledger balance, chooses a model from allocated capital/token policy, and leaves account admission to the Router. USD charges remain USD in billing metadata; unknown 0G costs are not treated as free inference. Direct SDK treasury deposits cannot fund a Router account. A management key with account-read scope would be needed for Router balance monitoring.

Run `pnpm exec tsx scripts/check-0g.ts` for a bounded catalog + inference check. It writes `.perpetua/0g-connection.json`, never prints the key, and never falls back to simulated output. During setup on 6 November 2026, the supplied key authenticated against mainnet but returned `402 insufficient_balance`; the documented testnet Router failed TLS/network requests, and its own dashboard reported “Failed to fetch.” This is a recorded observation, not a permanent service-status claim.

The direct Galileo service was reachable and listed registered acknowledged chatbot providers. `pnpm exec tsx agent/src/setup-testnet.ts` provisions a backend wallet and discovers those providers without moving funds. Send **4 testnet 0G** to the address it prints: the SDK requires 3 tokens to create a ledger, with the remainder retained for gas. Run the same command with `--activate` after funding. It requires chain 16602, initializes the direct ledger, makes a verified inference, then changes `ZG_MODE=live` only after success. Restart the API to load the selected mode. The API key remains saved for Router use; direct mode instead uses the backend wallet. Initial deposits are setup funds, not earned agent revenue.

## Futures research harness

`agent/src/hosted.ts` and `harness.ts` provide a separate bounded paper harness. Use an operator-controlled `HOSTED_ADAPTER_MODULE` exporting `createTools(definition)` and optionally `createBrain(definition)`. Knowledge tools expose account state, market snapshots, fresh execution observations and optional Arkiv lookup. The model can request at most three allowlisted read actions; it has no arbitrary code or transaction tool.

After inference the harness refreshes observations and checks age, spread, drift, costs, stop/target geometry, daily loss, leverage, margin and liquidation buffer. A passed preflight is a research proposal. It is **not** a live futures fill. Venue-specific margin calculations, reduce-only execution and reconciliation remain required. The supervisor prevents overlapping ticks within one process and replaces paper workers after configuration revisions.

## Arkiv and remaining setup

The configured public Signature Atlas importer is live on Rabdi, separate from agent identities. The initial funded run wrote 200 public signature records with zero errors; an independent query returned an owned selector entity. `ARKIV_IMPORTER_PRIVATE_KEY` funds this importer; `ARKIV_ACCESS_KEY` configures RPC access. `ATLAS_BATCH_SIZE=5` avoids oversized batch requests. Runtime agent records use the local outbox until per-agent `ARKIV_PRIVATE_KEY` identities are provisioned; the importer is not presented as an individual agent.

Before live operation, configure/fund verified 0G providers and isolated ledgers, a live trading venue and signer/deployment flow, per-agent Arkiv identities, and real CCIP sender/receiver deployments on supported networks. Add durable scheduler leases, database-backed sessions/operations, crash reconciliation, indexed history and bounded RPC deadlines before multi-process deployment. Local shared execution/compute keys are not a production isolation scheme. The existing cryptographic trade-intent/digest binding limitations remain described in the README.

Research: [futures strategies](research/futures-strategies.md), [harness architecture](research/harness-and-configuration.md), [sponsor requirements](research/sponsor-integration.md).
