# Hosted agents: shared wallet portfolio, minute runs, memory and Arkiv

Status: proposed architecture, not an implemented runtime. Prepared from the current repository on 2026-11-06.

Implementation update: the initial shared-host harness, API and `/runtime` controls are now implemented; see [operation and current limits](hosted-runtime.md). That implementation uses SQLite rather than PostgreSQL, reuses an existing owner allocation, and defaults to real-inference analysis. Dedicated portfolio contracts, bundled production execution/protection adapters, retention renewal and complete Arkiv disaster recovery remain outside the initial implementation.

## 1. Confirmed product requirements

- A wallet identifies a user. Agent names are unique within that wallet.
- A user funds one shared allocation that their agents can use. Different users never share capital.
- Agents run on our backend infrastructure. Inference uses server-side API calls; creating an agent does not create a VM or a model deployment.
- Every active agent makes an AI decision every minute, including an explicit hold decision when no trade is appropriate.
- Different agents analyze in parallel. Each agent receives current observations, its instructions/template, prior context and memory.
- Every run has a defined workflow. Decisions, concise decision explanations, actions and transaction lifecycle events are published to Arkiv.
- Agents can request additional market knowledge through controlled tools.
- Current-state observations and live decisions use direct live feeds and authoritative venue/chain reads. Past trends, historical observations and prior decisions are queried from Arkiv, whose publication can lag the live sources.

Interpretation of shared allocation: the user explicitly deposits into a shared portfolio vault/smart account on a selected chain. We do not grant the service unrestricted access to the user's entire MetaMask balance. One wallet can have multiple chain/settlement-asset portfolios, with each agent bound to exactly one portfolio in the first release. Cross-chain portfolios are a later extension.

## 2. What exists, and what must change

| Current implementation | Consequence for this design |
| --- | --- |
| `AgentDefinitions` saves UUID, owner, name, revision and validated configuration in JSON files. | Keep immutable IDs and configuration hashing; add a database uniqueness constraint on owner + normalized name, original instructions and immutable revisions. |
| `StrategyConfig` has spot/futures templates, 4h candles, risk/compute limits and configurable polling. | Introduce a new version with fixed 60-second decision cadence, explicit knowledge/tool requirements and instruction hashes. A minute decision cadence does not change the existing 4h strategy timeframe. |
| `deployLocalAgent` deploys vault/wallet/gate per agent. `PerpetuaVault.agentId` is immutable. | This does not implement shared capital. Introduce a portfolio identity and many agent bindings to a portfolio; migrate deployment, accounting and UI together. Existing wired vaults cannot simply be merged. |
| `startLocalRuntime` iterates and awaits agents sequentially, inside a process-local chain-operation lock. | Replace with durable scheduling and concurrent analysis; preserve serialization only where shared resources require it. |
| `AgentSupervisor` can run workers concurrently but its locks and schedules are in memory. | Reuse its worker abstraction, replace ownership of jobs with durable claims and fencing. |
| `PerpetuaAgent.tick()` checks wake conditions; the LLM supplies sentiment, not a complete portfolio decision. | Build a new run orchestrator. Reuse adapters/indicators/risk helpers rather than wrapping the old tick unchanged. |
| `PaperHarness` is futures-only, candidate-triggered, read-only and keeps deduplication in memory. Tool results are logged but are not fed through a full observation/action loop. | Generalize the bounded tool dispatcher and add explicit iterative observation handling, persistent memory and an execution coordinator. Preserve paper-only behavior until a venue is supported. |
| `Records` uses `vc.account.address`, the proposer, as its agent identity. Local agents share proposer/compute environment keys; Arkiv uses the supplied/global writer key. | Model owner, agent ID, portfolio, execution signer, inference account and Arkiv writer as distinct identities. Never infer the agent from a proposer or writer address. |
| `DecisionLog` stores input/output hashes, but the sentiment caller does not include the full decision explanation in payload. | New decision records must contain the actual structured decision and public rationale, not hashes alone. |
| `ArkivWriter` has an in-memory queue, mutable UID records and a local key map. Missing credentials cause local outbox writes. | Add a transactional durable outbox, append-only audit events and reconciliation after uncertain publication. Hosted mode cannot present a local outbox as successful Arkiv persistence. |
| Sessions, challenges and some budget/deduplication state are process-local. | Persist or centralize them before adding API/worker replicas. |
| Existing Arkiv market reads validate source hashes, writer identity and freshness. | Retain these for historical knowledge; add a direct live-feed gateway for current-state queries and capture exact observations for reproducibility. |

## 3. Identity, authorization and lifecycle

Use an internal immutable `agentId` (UUID), and expose `(ownerWallet, agentName)` as the human lookup. Normalize the owner address to its 20-byte identity. Preserve a checksum address for display. For names use a documented Unicode NFKC normalization, whitespace normalization and case-folding rule. Reject collisions atomically; `Atlas` and ` atlas ` belong to the same name namespace. The same name under another wallet is valid. Names are labels, never filenames, signing identities or memory keys.

Database constraints:

```text
users:                 UNIQUE(owner_wallet)
agents:                UNIQUE(owner_wallet, normalized_name)
portfolios:            UNIQUE(owner_wallet, chain_id, settlement_asset, allocation_key)
agent_versions:        UNIQUE(agent_id, revision)
agent_runs:            UNIQUE(agent_id, scheduled_minute)
run_steps:             UNIQUE(run_id, step_sequence)
actions:               UNIQUE(action_id), UNIQUE(idempotency_key)
transaction_events:    UNIQUE(chain_id, tx_hash, event_identity)
audit_outbox:          UNIQUE(event_id)
```

Every agent/portfolio relation must preserve owner equality. Carry owner and agent scope from authenticated server context, not from tool arguments chosen by the model. Rename keeps the immutable agent ID and its history; reserve retired names initially to avoid misleading history reuse. Lookup resolves a name to an ID before accessing state.

Agent lifecycle: `draft -> ready -> active -> paused -> archived`. `blocked` and `degraded` are health states, not implicit permission to execute. Keep execution mode (`paper`, `local-sim`, `live`) separate from lifecycle. Portfolio lifecycle separately tracks deployment, funding, withdrawals and recovery. Pausing one agent must not invoke a portfolio-wide withdrawal sleep.

The user flow:

1. Sign in with the existing domain-bound wallet challenge.
2. Create/select the shared portfolio, select a supported chain/asset, and deposit an explicit amount. Persist deployment steps and receipts so retries resume rather than redeploy.
3. Name an agent, choose a template and provide its instructions. Validate requested assets, pools, indicators, timeframes and actions against actual adapter capabilities.
4. Compile instructions into a versioned data specification. Preserve original text, interpreted rules, assumptions, unsupported requirements, template version, tool policy and hashes. No generated executable code.
5. Show the effective behavior and authority. The owner signs activation bound to agent ID, revision, instructions/config hashes, portfolio, mode, limits, allowed venues/pools/tools, compute policy, expiry and nonce. Deposit approval is separate from this permission.
6. Register the agent and its audit-writer binding, confirm required initial Arkiv records, then schedule its first minute run.
7. Show run status, latest explanation, shared funds, agent-attributed positions, costs and audit publication state. Logging out never stops an active agent.

Owner changes create a new revision and take effect at a run boundary. Revocation/pause also invalidates already-created, unexecuted proposals. Recheck active revision and delegation immediately before signing/submitting. Emergency owner stop remains available independently of an AI decision.

## 4. Runtime services

```text
Wallet UI -> API / configuration and activation
                        |
                 PostgreSQL runtime store
                        |
                minute scheduler -> run queue
                        |
                 analysis worker pool
                  /      |       \
          memory loader  tools   inference gateway
                        |
                  structured proposals
                        |
              wallet execution coordinator
                        |
          deterministic risk -> signer -> venue/chain
                        |
                 reconciliation workers

All services -> transactional audit outbox -> Arkiv publisher
Arkiv confirmed records -> history/memory queries and dashboard
Live venue feeds / chain RPC -> live-data gateway -> current-state tools
Shared market collector -> Arkiv market history -> historical tools
Captured live observations -> audit outbox -> Arkiv history
```

Use PostgreSQL for operational coordination, reservations, runs, checkpoints, sessions and pending publication. Arkiv remains the public queryable history and published memory source. This explicitly changes the existing schema comment that calls Arkiv the only database: scheduler leases and transactional capital reservations need a coordination store. Do not hold a database transaction open during inference, RPC or Arkiv network calls.

Start with one backend worker service containing separate logical queues; processes can be split later. No need for one process/container per agent or an extra workflow platform initially. PostgreSQL supports queue consumers using `FOR UPDATE SKIP LOCKED`; leases, recovery and application idempotency must still be implemented [PostgreSQL SELECT documentation](https://www.postgresql.org/docs/current/sql-select.html).

## 5. Minute scheduling and parallelism

- Derive each UTC slot from `floor(time / 60 seconds)`. Enqueue one run per active agent per slot, under a unique constraint. Analysis deadlines are measured from the slot, not eventual queue pickup.
- Parallelize runs across agents, including agents of the same owner. Share immutable public market observations; keep memory, instructions, proposals and tool authorization scoped per agent.
- Only one analysis run per agent may be active. Claim with a durable lease, heartbeat and increasing fence token. Each state mutation and execution admission checks the token. A stale worker cannot commit memory or execute after replacement.
- Budget a normal run to finish inside its minute. Initial candidate limits: 5 seconds for initial reads, 35 seconds total model/tool time, 10 seconds for validation/reservation/admission, with remaining time for persistence and scheduling margin. Benchmark before making these service promises. Transaction confirmation may continue asynchronously beyond a minute.
- Do not start a second overlapping run when a provider stalls. Record the missed slot as `skipped_previous_run_active`, cancel/expire the old analysis at its deadline, and reconcile any external request whose result is unknown. Cancellation does not prove the provider stopped or did not bill.
- Do not replay old minute decisions as current trades after downtime. Persist skipped-slot coverage, reconcile positions, then run the current slot. Explicit historical replay uses a separate mode with no execution authority.
- Enforce global, per-provider and per-wallet concurrency limits and fair scheduling. Record admission/rate-limit failures. An active healthy agent gets an inference request every minute; a failure or budget block gets an explicit run outcome rather than fabricated reasoning.

The old wake filter becomes information in the minute context (`no_new_4h_candle`), not a reason to skip the required AI call. A new minute should not re-enter the same 4h signal repeatedly: use persistent signal/opportunity identity, open-order state and re-entry rules.

## 6. One run's workflow

| Step | Inputs and work | Persisted result |
| --- | --- | --- |
| Claim | Active revision, owner delegation, lease, slot, budget admission | Run ID, fence, config/instructions/template hashes, status |
| Reconcile | Confirmed balances/positions, pending orders, receipts, withdrawals | Versioned shared portfolio snapshot, own lots, sibling exposure, uncertainties |
| Load context | Last completed run, last filled action, memory checkpoint, relevant historical episodes | Exact memory version, included event IDs, context hash |
| Observe | Current inputs from direct live feeds/chain reads, plus past trends from Arkiv, at recorded cutoffs | Source kind, observation IDs, source/collection times, hashes, freshness/missing-data flags |
| Analyze | Instructions + deterministic indicators + shared account state + memory | Inference request/result IDs, model, usage, public rationale, structured proposal or hold |
| Query tools | Bounded additional reads; feed observations back to the model | Requested tool, authorized arguments, outcome, observation references |
| Validate | Schema, permissions, decision age, template rules and effective risk limits | Accepted proposal or explicit rejection; never silently rewrite unsupported actions |
| Coordinate | Atomic reservation against current shared capital; resolve conflicts | Reservation or reason such as `wallet_budget_exhausted` |
| Execute | Refresh quote/risk state after model latency, approve, sign, submit | Action lifecycle, transaction/order identifiers and uncertainty state |
| Finish | Commit factual memory delta and audit events; track pending confirmations separately | Terminal analysis outcome, memory version, latest decision projection |

Use one initial inference call every minute. If more information is needed, allow up to two additional inference turns and four read-tool invocations within the same total deadline and budget; initial values are configurable service limits. Additional calls are not mandatory. All material tool results enter the next inference turn; a fetch must not merely be logged while the model decides without seeing it. On deadline/budget exhaustion, record a deterministic `hold` fallback, identifying its source as the runtime.

Every result distinguishes the model proposal from the executed outcome. Example: “Proposed buying ETH; execution blocked because another agent reserved the remaining exposure.” A hold, blocked trade, stale-data run, inference error and partial execution are different states.

The model returns a validated data object containing `decision`, `symbol/instrument/pool`, optional proposed sizing/protection, `rationaleSummary`, `evidenceRefs`, `invalidationConditions`, `reviewAfter`, and proposed memory updates. Persist a concise explanation of factors and evidence; internal model deliberation is not required. Confidence is optional descriptive output, not a calibrated win probability or permission to override policy.

## 7. Shared wallet allocation and conflict handling

All sibling agents see the same portfolio NAV, cash, aggregate exposures, pending reservations and relevant sibling proposals, alongside their own strategy lots. Their proposals are tentative until the wallet coordinator accepts them.

Maintain one portfolio vault/trading account and one aggregate risk authority per owner/chain allocation. Evaluate the CPPI floor/cushion and compute reserve once at portfolio level. Agent caps are additional maxima, not separate claims on the same cash. Do not report the portfolio NAV as independently owned by every agent or deduct a full compute reserve once per agent.

The coordinator atomically checks distinct constraints in their appropriate units: spendable cash, remaining exposure/risk capacity, gas reserve, per-agent policy, and reserved token/lot quantities. Existing approved and pending venue orders count until definitively settled/cancelled. Database reservations track workflow state; on-chain allowances and gate accounting remain authoritative for enforced limits. Avoid counting an approved order both as a DB reservation and again as on-chain exposure by linking them through its action ID and explicit phase.

Example: the wallet has $100 of **remaining tradable capacity**, and two agents independently propose $80. At most $100 can be reserved across them. The second proposal is either rejected or explicitly resized only if its signed policy permits resizing and fresh risk/quote checks succeed. Do not assume cash balance and permitted risk exposure are interchangeable.

Execution lanes are serialized per portfolio; independent portfolios run concurrently. A signer nonce lane is also serialized per `(chain, signer)` if multiple portfolios share a signer. Do not serialize the entire system or hold a wallet lock while waiting for minute-long inference.

Priority: pending owner withdrawal and protective actions first, then older accepted actions, then new entries using a stable rotating order among sibling agents. Do not use model confidence or fastest inference response to grant capital. Process available proposals against current reservations; the rotating order is a fairness preference, not permission to execute stale decisions. Publish allocation denial reasons.

For the first release, retain separate action/position lots per agent even when the wallet's token balances are fungible. A sale must reserve an agent-attributed quantity, not the wallet's full token balance. The sum of remaining lots must reconcile to actual holdings, with unassigned/manual transfers explicitly recorded. Only a portfolio risk/withdrawal operation can deliberately unwind another agent's lots, and must attribute the realized result to those lots. Pausing an agent keeps monitoring its existing positions; archiving requires an explicit keep/manage/close policy.

Start with no cross-agent order netting. Reject incompatible opposing exposure on the same venue instrument unless an adapter explicitly supports attribution and reduce-only semantics. Pool reuse does not grant rights over sibling positions. Any transaction that changes a shared pool position affects all dependent strategies and must be treated as a portfolio operation. LP/multi-leg actions remain unsupported until pool-position ownership, fee attribution and unwind adapters exist; current templates are spot/futures research, not LP strategies.

Agent P&L comes from attributed fills/lots minus its execution fees and billed inference. Shared lending income, common gas/maintenance and shared portfolio withdrawals need an explicit allocation policy, reported separately from trading skill. Portfolio equity and cash flows are canonical; do not sum duplicated per-agent NAVs for a leaderboard.

If aggregate limits must be on-chain but per-agent limits are application-enforced, state that distinction explicitly. Contract-enforced per-agent quotas require agent IDs, activation/config binding and replay protection in the checked intent, plus contract tests; the current RiskGate does not provide that boundary.

## 8. Memory and context construction

Persist four kinds of context, each with a different authority:

1. **Instructions:** owner-authored intent, validated constraints, template/version and supported tool plan. Only owner-authorized changes can edit these.
2. **Working context:** latest decision/explanation, outstanding actions, open attributed lots, unresolved uncertainties, next review/invalidation conditions, last observations.
3. **Episodes:** past decisions, rejected actions, fills, losses, fee/funding events and owner overrides. Use explicit links to the underlying run/action/transaction.
4. **Summaries:** bounded rolling strategy memory, with source event IDs, covered sequence range, configuration version and factual versus model-inferred labels.

Each run loads the previous completed context plus newer reconciliation events, recent decisions (initially five), open-lot origin decisions, and a small set of relevant older episodes by symbol/pool/event type. Begin with structured indexes, not an unbounded transcript or a required vector database. Add semantic search only when retrieval measurements justify it; it must preserve owner/agent filters and source references.

The memory checkpoint is committed with the terminal run events and outbox rows in one operational database transaction. Include its hash and public content in the Arkiv publication. It is usable as unpublished local context only when clearly labelled; never claim it is already confirmed on Arkiv. Recovery can rebuild it from confirmed Arkiv events plus the durable unpublished tail. If both are unavailable, block new entries until context and account reconciliation succeed.

Proposed model memory edits are suggestions. Code derives position balances, P&L, order status and limits from reconciled facts. Repeating a previous narrative does not make it true. Historical thoughts never override current balances or new owner instructions. Memory summaries cannot silently change risk rules. After a strategy revision, carry forward factual positions/outstanding actions and explicitly supersede incompatible strategy assumptions.

Publish human-readable strategic memory and decision explanations on Arkiv. All current Arkiv schemas are public, so creation must explain this. Keep credentials and operational secrets out of public payloads. Original public strategy instructions can be stored in full; any future private-instruction mode needs encrypted storage and a separate disclosure policy rather than accidentally publishing text.

## 9. Knowledge tools and market provenance

Tool capabilities are derived from the validated template and effective instructions at activation. Unsupported requirements block activation or require a revised draft. User prose can select supported tools and parameters; it cannot invent a tool or expand execution authority.

| Tool | Purpose and scope |
| --- | --- |
| `market.live` | Direct live-feed quote/book/mark/index/funding/open interest for authorized instruments with source-specific freshness. Never resolved through Arkiv's latest mirror. |
| `market.history` / `market.indicators` | Arkiv historical observations and closed candles for past trends and deterministic configured indicators, with bounded history, coverage and permitted timeframes. |
| `pool.live` | Current authoritative chain state for a supported protocol/pool ID; adapter reports block, liquidity, fees and price impact. Not available until implemented. |
| `portfolio.current` | Current authoritative wallet/venue state plus this agent's reconciled lots, operational reservations and sibling aggregate exposure. Arkiv supplies history, not current balances. |
| `orders.current` | Current venue/chain status of scoped outstanding actions, reconciled with the operational journal. |
| `memory.search` | Owner/agent-scoped episodes using bounded query parameters. |
| `arkiv.history` | Approved writer-filtered decisions/market records, with entity keys and pagination. |
| `atlas.lookup` | Corroborating signature metadata; never evidence that arbitrary contract execution is safe. |

The model has no raw signer, contract-call, shell or arbitrary-URL tool. Pool/venue IDs resolve through server-owned adapter configuration. Shared data requests can be coalesced by source/instrument/window/cutoff, but tool authorization and results remain scoped to each agent. Additional news or protocol facts require explicit adapters with provenance and bounds.

Use two explicit data paths. Requests for "now", current price, current pool liquidity, current positions or open orders go to direct live-feed/venue/chain adapters. Historical windows, past trends and previous decisions go to Arkiv. A recent Arkiv publication is still a mirrored historical observation; it is not an interchangeable answer to a current-state request. The tool dispatcher enforces this source choice rather than relying on the model to remember it.

Maintain shared live subscriptions or bounded direct polling per venue/instrument, and let concurrent agents read the same timestamped live snapshot when it meets their freshness requirement. A new tool request during a run checks freshness again and refreshes if needed; it must not blindly reuse the snapshot from the start of the minute. Stream gaps, disconnects or out-of-order updates invalidate live state until resynchronized. Current pool/account/order state uses its authoritative chain or venue adapter, with block/confirmation semantics reported explicitly.

Every observation carries `sourceKind` (`live_feed`, `chain_read` or `arkiv_history`), venue/product/instrument, source timestamp or block, received time, age and content hash. Historical results also carry Arkiv entity keys and covered time ranges. Capture the exact live inputs used in each decision and publish them or immutable content-linked snapshots to Arkiv through the audit outbox; they become history for later runs. Do not require live market data to be published before the model can read it.

When combining historical trends with live observations, expose Arkiv's last covered timestamp and any gap to the live timestamp. Do not fill a missing historical interval with invented candles or treat the current partial candle as closed. If a required trend window is incomplete, refresh missing closed candles from an explicitly supported direct history adapter, labelled with its true source and queued for publication, or return an insufficient-history hold. Live-only analysis may continue when its validated template does not require the missing history.

Recheck freshness on cached live results. If a required live source is unavailable, record `live_data_unavailable` or `live_data_stale` and block dependent new risk; do not silently fall back to Arkiv history as "current". Market tools report venue and product type: a Binance perpetual mark is contextual knowledge, not an executable Flash spot price.

Execution always refreshes its own venue quote and authoritative chain/account state after inference and capital arbitration. Missing or stale observations lead to an auditable hold. No synthetic fallback in hosted live mode.

## 10. Arkiv records and publication

Introduce versioned runtime schemas alongside the existing signal/market/Atlas schemas. Every runtime record carries `owner_wallet`, `agent_id` when applicable, `portfolio_id`, revision/config hash, event ID, sequence, timestamp and public payload. Index only fields needed for supported queries; fit indexed values to the installed SDK's schema limits.

| Entity | Semantics |
| --- | --- |
| `AgentDefinitionVersion` | Immutable effective instructions/config, owner authorization and capability hashes. |
| `AgentBinding` | Agent -> owner -> portfolio -> execution authority -> approved Arkiv writer, versioned and revocable. |
| `AgentRun` | Scheduled/start/end times, state, context/observation hashes, inference IDs, usage and error. |
| `AgentDecision` | Structured proposal/hold, rationale and evidence. Each completed minute produces one, even if no action follows. |
| `AgentActionEvent` | Append-only proposed/validated/reserved/rejected/submitted/partially-filled/filled/cancelled/failed/unknown lifecycle. Tool invocations/results are typed action events too. |
| `TransactionEvent` | Chain, signer/from/to, action, hash, nonce, submitted/mined/reverted/replaced/reorged/finalized state, block/receipt references and amounts. |
| `AgentMemoryCheckpoint` | Versioned bounded public context, source range and hash. |
| `PortfolioEvent` | Deposits, withdrawals, reservations, risk overrides, reconciliations, yield and common costs. Agent links are optional for portfolio-wide activity. |
| `AgentLatest` | Mutable convenience projection pointing to the newest terminal run/decision/memory and execution outcome. |

Immutable history is never replaced by patching `AgentLatest`. Update the latest projection only after its referenced history is confirmed, and guard it with monotonic run sequence/config version so delayed publishers cannot move it backwards. Return latest AI decision and latest execution outcome separately. A newer decision may exist while an older order is still pending.

Use deterministic logical IDs such as `agentId:scheduledMinute:stepSequence` and `actionId:eventSequence`. Arkiv entity keys and logical IDs are different. A UID field alone does not enforce uniqueness; operational constraints, publisher ownership and read reconciliation do. Chain logs use chain/tx/log identity and preserve fork/reorg state.

**Publication protocol:** commit runtime events, state changes and outbox entries atomically before any external side effect. A publisher claims durable batches, submits them, records publication tx/entity keys, confirms them and advances per-agent publication sequence. If submission succeeds but acknowledgement is lost, inspect the tx/logical event IDs before creating duplicates. Serialize nonce use per Arkiv writer. Never delete an outbox entry until confirmation or a verified equivalent existing entity.

For v1, use an explicitly registered platform audit writer (shardable later), and query with that writer plus agent/owner IDs. Arkiv ownership identifies the writer, not the end-user wallet [Arkiv ownership model](https://docs.arkiv.network/start-here/introduction/). Publish the owner-signed activation binding so attribution can be checked. Update registry/query assumptions that currently require `ownedBy(agentAddress)`. This provides platform-attributed evidence; venue/chain receipts are still required to corroborate execution.

An operational database and Arkiv cannot commit atomically. Proposed live-entry policy: require the decision and action intent to be confirmed on Arkiv before admitting a new risk-increasing submission, then refresh price/delegation/reservation validity. Publication delay beyond the run deadline means no new entry. Post-execution receipts publish asynchronously. Protective exits and owner withdrawals may proceed from a durable local journal during an Arkiv outage, retain all events for retry, and expose `audit_pending`. Do not claim every execution result is immediately confirmed on Arkiv.

Arkiv entities expire and owners can extend their lifetime; implement a funded renewal job, expiry monitoring and export/restore policy. Do not describe records as permanent without operating that retention policy [Arkiv expiration documentation](https://docs.arkiv.network/writing/expiration/). Proposed retention is 180 days of detailed public run/action history with renewal for active definitions/current memory and selected long-lived records; validate network/SDK limits before setting it. Hash links detect inconsistent application history only relative to an independently retained/published checkpoint; they do not make owner-mutable entities intrinsically immutable.

Decide whether paid signal embargoes remain a product requirement. Immediate public decision rationale can reveal direction/levels before the existing 15-minute signal reveal. Default for this requested runtime is immediate public decisions; do not promise exclusive delayed signals for the same information. A delayed-publication product would need a different visibility policy.

## 11. Execution, recovery and withdrawals

Analysis runs produce proposals; only the execution coordinator can invoke signing adapters. Use deterministic action IDs and write-ahead intents. An order acceptance is not a fill; a timeout is not a failure. Keep separate submission, settlement and reconciliation states, including partial fills and replaced/reverted transactions.

On crash recovery, reconcile reservations, signer nonces, transaction receipts and venue order IDs before releasing funds or retrying. Retry unknown submissions only if the venue supports a verified idempotency mechanism; otherwise freeze the uncertain action for reconciliation. A lease fence blocks stale state writes but cannot cancel a transaction already broadcast. Outstanding actions therefore remain part of the shared risk budget across lease changes and minute boundaries.

A separate portfolio protection/reconciliation worker monitors positions without waiting for AI. Existing `ensureStops()` currently warns about missing stops; it does not implement the protective action suggested by its comment. `closeRiskyPositions()` explicitly leaves live positions open without an exit adapter. Implement actual order/protection lifecycle adapters and verification before relying on them.

The current gate verifies the intent/digest relationship only when an order hasher is configured; TEE proof does not bind the response to the particular order. The shared portfolio design must bind checked intent, bracket terms, action/portfolio identity, mandate and expiry to signed execution. Existing Router verification metadata is not the signer-bound proof RiskGate expects. Hosted inference eligibility and execution-proof eligibility must be separate checks.

Wallet withdrawals take priority over new entries, freeze the portfolio entry lane, cancel/reconcile pending orders, close the necessary attributed lots, and refresh the shared gate. Full withdrawal pauses all funded agents; partial withdrawal reevaluates all agents' capital eligibility without falsely claiming each owns the whole allocation. Deposits/withdrawals change portfolio cash flow, not strategy profit.

## 12. Compute accounting and sizing

Centralize inference in a backend gateway. Share our provider account/API credentials through server-side references while isolating prompts, requests and budget attribution by owner/agent/run. This is separate from sharing trading capital. No provider conversation ID or history is reused between agents.

Reserve estimated maximum token/cost usage before each call against agent, wallet and platform budgets; settle actual verified charges afterward. Unknown charges remain reserved until reconciled. Track native billing currency without inventing a 0G conversion. A shared provider balance delta cannot accurately attribute concurrent calls; prefer request-level usage/receipts and explicit unreconciled amounts. Per-agent model thresholds under shared capital must use an explicit compute entitlement or user-selected model tier, not multiply the shared NAV into several independent capital claims.

Operator-funded API inference is the initial billing mode implied here. Do not silently harvest user principal for compute. If portfolio earnings will reimburse inference, show and sign the exact expense policy, record it once in portfolio accounting and attribute per-call usage to agents. Existing direct 0G ledger/CCIP self-funding remains a separately enabled funding adapter; it is not automatically compatible with a shared Router account.

For N continuously active agents:

```text
minimum initial inference requests/day = 1,440 * N
initial inference request rate        = N / 60 per second
average inference concurrency         ~= N * mean_request_seconds / 60
provider spend/day                    = sum(request-level billed usage)
audit volume/day                      = 1,440 * N * mean_events_per_run
```

At 100 active agents and an assumed measured mean of 20 seconds, average initial inference concurrency would be about 34, with 144,000 initial calls/day before tool follow-ups. This is a capacity example, not a provider performance claim. Provision for bursts/tail latency, publication writes, RPC quotas and chain signer throughput. Enforce per-wallet agent admission so one wallet cannot consume all model capacity.

Monitor schedule lag, run p50/p95/deadline misses, provider rate limits, spend reservations, wallet reservation contention, reconciliation age, unknown submissions, queue depth, outbox age, Arkiv confirmation lag and expiry runway. Show a missed-run reason instead of claiming every-minute success when capacity is insufficient.

## 13. Repository implementation sequence

1. **Identity and shared portfolio foundation.** Add operational store/migrations and repositories for users, agents/versions, portfolios, bindings and authorization. Enforce unique wallet/name identities. Introduce portfolio contracts/deployment semantics and shared account reads; keep existing demo deployments intact and explicitly separate. Migrate portfolio ownership, gates, treasury/fees, registry bindings and leaderboard semantics together.
2. **Complete audit path.** Add `arkiv/src/runtime-schemas.ts`, runtime query helpers and a durable publisher. Persist decisions, steps, actions and transactions with recovery and provenance before adding concurrent execution. Build confirmed-history and pending-publication views.
3. **Minute decision runtime.** Add `agent/src/runtime/{scheduler,run,context,tools,inference,memory}.ts` backed by durable job claims, plus a shared live-feed gateway. Unify spot and futures-paper analysis behind capabilities. Run AI every minute using live current-state observations and Arkiv historical trends, with a structured hold/proposal and complete public rationale. Add Arkiv-backed history retrieval, captured live-input publication and source-linked checkpoints.
4. **Shared execution coordinator.** Add `agent/src/runtime/{portfolio-coordinator,reservations,executor,reconciler}.ts`. Start with local simulated spot settlement using actual shared balances; prove no overspend and correct lot attribution. Only supported adapters can receive execution capabilities.
5. **Activation and product UI.** Add portfolio selection/funding, effective-config review, explicit activate/pause/resume, latest decision/evidence, run history, agent versus portfolio P&L, memory view and audit confirmation links. Use owner/agent IDs in APIs, with name lookup for display/navigation.
6. **Live readiness.** Implement supported-venue lifecycle/protection adapters, checked digest binding, delegation revocation, signer isolation, shared account risk tests and real provider proof/billing integration. Then enable owner-authorized live mode for supported capabilities. Futures and LP execution remain unavailable until their adapters and accounting exist.

Suggested APIs: `POST /v1/portfolios`, `GET /v1/portfolios/:id`, `POST /v1/agents/:id/activate|pause|resume`, `GET /v1/agents/:id/runs`, `GET /v1/agents/:id/decision`, `GET /v1/agents/:id/memory`, `GET /v1/portfolios/:id/actions`. Lifecycle changes require exact signed authorization and wallet ownership checks, as do current configuration mutations. This extends existing endpoints rather than replacing wallet authentication.

## 14. Acceptance scenarios

- Same wallet cannot create equivalent normalized names concurrently; different wallets can. Renaming preserves history and memory.
- Three sibling agents call inference in parallel each minute, have isolated prompts/memory, see shared capital and cannot exceed it with simultaneous proposals.
- Every healthy scheduled run includes a real inference request. Holds, errors, missed slots and budget blocks have truthful distinct records.
- Tool results are fed back into reasoning, cannot access another user's data, and cannot request unsupported symbols/pools or execution.
- Current-state tools read direct live sources even when an Arkiv latest record exists. Historical tools query Arkiv with explicit coverage; missing live data cannot be replaced by mirrored history. Mid-run current-state requests refresh stale snapshots, and exact decision inputs remain reproducible from the audit record.
- Worker/API restart reconstructs context and pending actions. Two worker replicas cannot concurrently commit the same run or double-submit an action.
- An accepted or unknown order reserves exposure across minutes and restarts. Partial fills, cancellation, replaced transactions and reorgs preserve attribution and correct available capacity.
- Two agents holding the same token cannot accidentally sell each other's lot. Portfolio withdrawals can unwind both with explicit attribution.
- Updating/pausing an agent while its inference runs prevents its old proposal from executing. Other agents on the portfolio can continue unless a wallet-wide control blocks them.
- Stale market data, missing proof, failed risk checks or delayed pre-entry Arkiv publication block new risk; existing-position monitoring remains operational.
- Every run, tool action and transaction lifecycle is queryable on Arkiv by approved writer + owner + agent/run/action IDs. Publication recovery cannot silently drop events or move latest state backwards.
- Memory can be reconstructed from the audit history and unpublished durable tail; unsupported model assertions never change balances or permissions.
- Shared portfolio cash flow/NAV agrees with chain/venue reconciliation, agent P&L does not count deposits, and fees/inference charges are attributed once.
- Under a documented load target, measure actual minute completion and publication latency; report cost/capacity limits before allowing more active agents.

## 15. Product choices still open

The architecture assumes one shared allocation per wallet/chain/settlement asset, user-approved deposit authority, operator-funded inference, immediate public decisions and per-agent attributed lots without cross-agent netting. These are concrete defaults for planning, not accepted changes to existing live credentials or funding behavior.

Before implementation, select the initial execution capability (local spot, live supported spot, or paper futures), the permitted live pools/venues, user-configurable versus equal rotating execution priority, whether inference is platform-sponsored or reimbursed, and the detailed retention policy. None of those choices changes the confirmed shared-capital or every-minute AI requirements.
