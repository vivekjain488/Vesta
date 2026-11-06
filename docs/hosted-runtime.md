# Running the minute harness

The runtime is implemented in `agent/src/runtime/`. It runs independent minute decisions concurrently, uses direct live market feeds for current state, uses Arkiv for historical trends, persists memory between runs, and publishes a durable audit journal to Arkiv. Users are identified by wallet; names are unique within a wallet after normalization.

## Start it

Requires Node >=22.13 and the repository's installed dependencies. Operational state is `.perpetua/runtime.sqlite` (SQLite WAL). API and worker processes must share this file on the same host. This implementation does not use the PostgreSQL deployment proposed in the architecture plan; distributed hosts require a corresponding transactional store implementation before deployment.

Configure these in the existing root `.env`:

```dotenv
HOSTED_RUNTIME_ENABLED=true
ZG_MODE=router
ZG_API_KEY=<funded server-side inference key>
ZG_BASE_URL=<the Router endpoint for that key>
ZG_MODEL_SMALL=<available verified model>
ARKIV_RUNTIME_PRIVATE_KEY=<dedicated funded Arkiv publisher key>
ARKIV_RUNTIME_WRITER_ADDRESS=<matching publisher address>
ARKIV_MARKET_WRITER_ADDRESS=<trusted existing market-history publisher>
```

Direct provider inference (`ZG_MODE=live`) is also supported with the existing 0G provider/ledger configuration. There is no simulated inference fallback. The runtime does not initialize or fund a new ledger automatically. Router verification must report `tee_verified=true`; an unverified response becomes an explicit failed/hold outcome.

## Test with OpenRouter

Set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in the root `.env`, then select OpenRouter explicitly:

```sh
pnpm api --openrouter
pnpm hosted --openrouter
```

Run them in separate terminals alongside the frontend. Pass the flag to both API and worker so activation and minute decisions select the same provider. Alternatively, set `INFERENCE_PROVIDER=openrouter` in the shared environment and use the regular commands. `--openrouter` overrides the environment selection without editing `ZG_MODE` or saved credentials. Without an override, 0G selection continues to follow `ZG_MODE`. This flag applies to the new hosted harness/API; `pnpm agent` remains the legacy 0G trading loop.

`OPENROUTER_MODEL_LARGE` optionally selects a different large-tier model; otherwise both tiers use `OPENROUTER_MODEL`. Model slugs are explicit configuration, with no silent fallback to another provider. Existing market data, memory, token reservations and Arkiv audit behavior stay in use. The flag does not bypass the required funded Arkiv writer or portfolio/market setup. Strategy drafting separately uses OpenRouter Qwen3.7 Flash with a 2,000-token output limit when `CONFIG_COMPILER_ENABLED=true` and `OPENROUTER_API_KEY` is set, regardless of the runtime inference provider.

OpenRouter results are recorded with `backend=openrouter`, `testingOnly=true`, `verified=null`, no TEE proof, and USD billing metadata when the provider reports it. They can produce analysis decisions and reviewed strategy drafts; they cannot authorize live execution. Starting the worker with this flag disables its execution adapter, and an existing execute-mode agent gets an explicit failed run until activated in analysis mode. Provider errors and timeouts do not trigger retries or a switch to 0G; uncertain token reservations remain consumed.

`agent/src/inference/` is the inference boundary: `InferenceProvider.complete()` accepts messages, model policy, output budget and cancellation, and returns normalized content, usage/billing and provenance. OpenRouter implements it directly; compatibility adapters wrap the existing direct/Router 0G clients. Ledger funding and signing remain outside that interface. A trusted runtime adapter supplies `inference(agent)` rather than `brain(agent)`; the API strategy compiler has a separately configured OpenRouter provider. The OpenRouter adapter uses the documented [Chat Completions endpoint](https://openrouter.ai/docs/api/reference/overview) with [Bearer authentication](https://openrouter.ai/docs/api/reference/authentication).

Restart the API after setting the flag, then run the service:

```sh
pnpm api
pnpm hosted
pnpm arena
```

Use separate terminals. `HOSTED_RUNTIME_ENABLED=true` stops the API's old local spot worker from trading outside the new coordinator. Do not also run `pnpm agent` against the same allocation. The earlier paper harness remains available as `pnpm --filter @perpetua/agent hosted:paper`.

## User flow

Open `/runtime` or **Hosted agents** in the app navigation. Sign in with the existing wallet flow.

1. Connect an existing owned vault allocation as the shared portfolio. The API verifies its on-chain owner. This reuses an existing allocation; it does not merge independently deployed vaults or move funds.
2. Choose the shared portfolio. Create an agent name, template, assets and instructions. The app saves a signed definition, then requests a separate signature activating that exact revision/configuration/instructions against the portfolio.
3. The provided UI activates **analysis mode**. Active agents call real inference every minute and record proposals/holds; analysis never submits trades. Each agent has separate instructions, decisions and memory while observing the shared portfolio.
4. Inspect an agent to see its latest rationale, memory version and confirmed/pending event counts. Read the confirmed history directly from Arkiv with the history button.
5. Pause an agent to revoke its unfinished decisions and pending submissions. Resume by activating it again. A new activation generation prevents an older in-flight result from becoming valid again.

Templates retain their validated numeric parameters and closed 4h timeframe. The minute cadence is independent of candle cadence. Free-form instructions add model analysis context; they do not silently change deterministic template limits, enable new tools or implement unsupported strategies. The default gateway uses the small model and platform-sponsored API inference; legacy per-agent direct-ledger funding/tier assumptions do not apply to a shared Router account. Daily token reservations are durable across agents, wallets, restarts and worker processes. They are conservative admission limits, not an exact currency billing ceiling. Request-level reported usage/billing is recorded separately.

## Per-minute workflow

Each UTC minute gets a unique `(agentId, minute)` run. A database claim prevents duplicate runs across worker processes. The run captures its configuration/activation generation, loads its memory/recent runs, and concurrently requests live observations, historical trend windows and current portfolio state.

Current market tools use direct Binance spot REST data or the existing direct Binance USD-M collector. Concurrent live requests are coalesced only while in flight; a later tool call fetches again. No Arkiv latest mirror is substituted for live data. Historical closed candles come from the trusted Arkiv mirror and explicitly retain their coverage time and venue/product identity. The bundled historical mirror is USD-M perpetual data even for a spot agent, and is labelled as such; it is contextual trend knowledge, not an executable spot quote. Missing required history or live observations block execution admission while still allowing the minute AI call to explain the missing data.

The model can request up to four additional read tools over at most three inference turns: `market.live`, `market.history`, `portfolio.current`, and `memory.search`. Tool results are returned to the next model turn. Symbols, history length, source kind, observation age and argument keys are checked by code. `memory.search` returns scoped local episodes and, when configured, writer-filtered public Arkiv history. Tools have no raw signing, arbitrary URLs, code execution or cross-user identity argument.

Every normal run produces a validated decision and a public rationale. Captured inputs, inference metadata/output, tool events, proposal disposition and memory checkpoint are written durably. Errors, deadline misses, budget blocks and worker gaps are visible; missed minutes are never replayed as current trades. Model summaries are explicitly model context, while balances and execution state are supplied again from authoritative adapters each run.

## Arkiv publication

`perpetua.runtime-event.v1` stores owner, agent ID, portfolio, run, revision, sequence, event type, timestamp and full public payload. Records are created with the SDK's readonly flag. Publication is batched (up to five events and a bounded payload per transaction), and uses a dedicated publisher with one durable writer lane. The application distinguishes the operational journal from confirmed Arkiv records.

The outbox and runtime updates commit together. A failed acknowledgement is reconciled by writer + logical event ID before any create is retried. If a send has an unknown outcome and no entity is visible, publication stops on that event rather than risking a duplicate; the service logs the event ID for operator reconciliation. Keep the SQLite database and WAL backed up, and retain writer transaction history. Unknown submissions require checking the dedicated writer's receipts before clearing/recovering publication state. The runtime deliberately does not guess that a timeout means no transaction was sent.

Records currently have 180-day expiry. Automated expiry renewal and full recovery of a lost operational database from Arkiv are not implemented. Do not delete the database or present this retention as permanent. Local memory survives process restarts; Arkiv history remains independently queryable while retained. There is no automatic deployment, key funding, credential edit or inference charge just from adding this code; charges begin when the configured worker runs an activated agent.

## Execution adapter

The harness includes capital reservation, confirmed-intent admission, serialization per portfolio, write-ahead submission state, transaction audit events and reconciliation. No production execution adapter is bundled: the repository's existing live exit/protection and order-binding gaps still need venue-specific implementation. The UI therefore uses analysis mode.

An operator can provide `HOSTED_RUNTIME_ADAPTER_MODULE`, exporting `createRuntimePorts(defaults)` and overriding supported ports. An `executor` must implement the `ExecutionAdapter` interface in `agent/src/runtime/types.ts`:

- `authorizeActivation`: verify the precise configuration, portfolio, supported venue and delegated authority.
- `validate`: fetch fresh executable prices/account state, check all effective risk limits, strategy opportunity deduplication, protection/proof/order-digest binding and agent-attributed lots.
- `submit`: use the durable action ID as the venue idempotency key, manage signer nonces, and return actual submission/receipt references. The same signer across portfolios needs signer-level serialization inside the adapter.
- `reconcile`: resolve submitted/unknown/partial orders without blindly resending. Do not return `filled` until fills and quantities are reconciled. Pending risk must stay reserved.

To authorize execute mode through the API, the operator must also set `HOSTED_RUNTIME_EXECUTION_ENABLED=true`; the owner signs `mode=execute` and the adapter's activation check must pass. The adapter cannot be supplied as user input. Analysis activation does not imply execution consent. Keep API and worker adapter configuration identical.

Buys atomically reserve cash and exposure capacity across siblings. Sells claim an exclusive pending exit lane per instrument, but lot ownership/quantity validation belongs to the trusted adapter. Opposing pending actions are blocked. Reservations are conservative; they do not replace RiskGate or venue constraints. Approved and uncertain submissions remain reserved across restart until reconciled. Before new risk, the model decision and action intent must be confirmed on Arkiv. Pause, activation-generation change and expired decisions invalidate reserved proposals. Protective monitoring and withdrawals still require the corresponding portfolio/venue service; the new harness does not turn the old warning-only stop checks into functioning live protection.

## API and verification

All routes below require the existing wallet session. Mutations also require the exact action/payload signature through `/v1/config/challenge`.

| Route | Purpose / signed action |
| --- | --- |
| `GET /v1/runtime/portfolios` | List wallet-owned shared bindings. |
| `POST /v1/runtime/portfolios` | `{deploymentAgentId}` / `bind-portfolio`. |
| `GET /v1/runtime/agents` | List wallet-scoped runtime agents. |
| `POST /v1/runtime/agents/:id/activate` | `{id,revision,portfolioId,mode,configHash,instructionsHash}` / `activate-runtime`. |
| `POST /v1/runtime/agents/:id/pause` | `{id}` / `pause-runtime`. |
| `GET /v1/runtime/agents/:id/runs` | Recent minute outcomes. |
| `GET /v1/runtime/agents/:id/decision` | Latest terminal decision, actions and publication counts. |
| `GET /v1/runtime/agents/:id/memory` | Durable memory checkpoint. |
| `GET /v1/runtime/agents/:id/events?source=arkiv` | Approved-writer public events; omit source for the operational journal. |

Run `pnpm --filter @perpetua/core test` and `pnpm typecheck`. Runtime tests use isolated SQLite files and injected deterministic adapters; they do not consume inference credits, publish to Arkiv or trade live funds.
# TradingAgents-inspired research workflow

Every hosted agent uses the same research workflow, while retaining its own instructions, template, wallet, memory and limits. The implementation is inspired by the role-based design of [TradingAgents](https://github.com/TauricResearch/TradingAgents), which is Apache-2.0 licensed; it does not embed that project or run its Python framework.

Each minute the agent first reads current direct market and portfolio data and older Arkiv history. A model call produces market and portfolio analysis, and a second call evaluates bull and bear cases and a research manager's conditional plan. The final decision call performs the trader, risk manager and portfolio manager roles, with the existing bounded read-only tool loop. These roles share one inference provider; they are prompted roles, not independent models. Research and inference results are journaled through the existing Arkiv outbox. If a research response is malformed, unverified, over budget, or misses the run deadline, the run fails closed. Current news, social and fundamental feeds are not supplied by this workflow and must be reported as unavailable rather than inferred.

This adds two inference calls per agent per minute and can increase cost and latency. Existing per-agent, wallet and platform token budgets apply to each call. A trade proposal is rejected if its latest quoted market observation is older than ten seconds when the decision is made; the trader can request a fresh quote. Normal wallet risk checks, intent publication, action expiry and execution validation still apply.

This architecture does not guarantee profitability or identify a permanently best agent. Compare strategies on the leaderboard over multiple market periods, including fees, drawdown and out-of-sample results, before drawing conclusions. Paper results do not establish live performance.
