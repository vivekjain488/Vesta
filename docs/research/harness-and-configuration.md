# Agent harness and configuration: design research

Research note, 6 November 2026. This describes the intended architecture and the existing repository's limits; it is not a claim that all components below are implemented.

## What exists today

- The deployed demo creates a vault, `RiskGate`, and `AgentWallet` for each named agent. `AgentRegistry` records an operator and arbitrary contract addresses for each ID, but does not authenticate an off-chain configuration, index agents by owner, or prove the registered contracts are related. The sample deployment derives IDs from names and registers them from the deployer. See `contracts/src/AgentRegistry.sol` and `contracts/script/Deploy.s.sol`.
- `agent/src/config.ts` loads one agent from environment variables and a deployment file; `agent/src/main.ts` runs one loop. `agent/src/agent.ts` persists state under a name-derived filename, reads only the first configured asset in its decision path, and may run overlapping ticks because its asynchronous interval is not serialized.
- `packages/core/src/strategy.ts` implements spot-only, long-or-flat momentum, mean-reversion, and DCA branches. The model scores headlines; deterministic code generates and sizes the signal, and the on-chain gate checks an order. The DCA branch currently buys when evaluated, not on its own calendar schedule. Parameter names and marketing descriptions should reflect actual supported behavior.
- The 0G integration uses `/chat/completions` and parses free-form JSON. It does not currently advertise or implement a function-calling protocol. A harness should own tool dispatch explicitly and use structured output only where its selected provider supports it; an application-side schema validator remains necessary.

## Configuration and ownership

Give every agent an opaque, immutable ID. Distinguish the authenticated **owner address**, which may own many agents, from each agent's trading wallet, vault, proposer, and compute identity. Scope all agent reads and mutations to the verified owner and agent ID; never accept an owner address in a request as proof of ownership. An off-chain owner record does not confer control over an already deployed contract. Verify on-chain owner, gate, vault, wallet, chain, and proposer relationships before exposing a live binding, and reflect any contract ownership change in authorization.

For a hosted API, use Sign-In with Ethereum with a server-issued, single-use nonce, expected domain/origin and chain, signature validation (including ERC-1271 where supported), expiry, and a session bound to the verified address. A connected wallet address by itself is not authentication. See [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361). If authorizing a specific configuration using typed data, bind owner, chain, agent ID, canonical configuration hash, version, deadline, and a consumed nonce; [EIP-712](https://eips.ethereum.org/EIPS/eip-712) explicitly does not itself provide replay protection.

An illustrative versioned configuration shape is:

```json
{
  "schemaVersion": 1,
  "market": "spot",
  "mode": "paper",
  "strategy": { "kind": "momentum", "minScore": 0.35, "minAgreeing": 3, "minRewardRisk": 2 },
  "assets": ["LINK"],
  "schedule": { "intervalSeconds": 3600 },
  "limits": { "maxPositionUsd": 100, "maxDailyLossUsd": 25 }
}
```

This is a design example, not a promised schema or default risk recommendation. Use explicit units, finite bounded numbers, a discriminated strategy type, asset allowlists, and rejection of unknown fields. Validate cross-field invariants and environment/venue capabilities. Persist original user intent, compiler version, normalized version, source/template, unsupported clauses and creation time separately from secrets. Changing a configuration creates a new version; every run and proposal records the exact version. Values cannot loosen on-chain gate limits: the effective limit is the stricter applicable bound. Never silently accept a parameter that the execution engine ignores.

Natural-language compilation should return a draft plus an explanation and unsupported or ambiguous clauses. A model must not execute code, choose credentials, enable live trading, or silently replace an unsupported clause with a default. Validate its result with deterministic code; if a request cannot be represented faithfully, ask for clarification or reject that part. Display the complete effective strategy for the owner to review and explicitly save. Saving a generated draft does not activate live trading. Live activation requires a separate owner-authorized operation, scoped to the exact configuration and binding, and remains unavailable until the execution controls described below exist.

## Harness and tool boundaries

Each due run loads a specific active configuration and an isolated agent state snapshot; obtains fresh, timestamped, source-labelled market data and position/mandate data; computes deterministic indicators; asks a model for bounded analysis or a proposed action only when appropriate; validates the proposal; applies deterministic policy; and records the outcome. Stale, missing, malformed, or conflicting data should block new entries and remain visible as an error. Protect and monitor existing positions independently of whether an inference succeeds.

Use a finite application-controlled tool registry, such as `read_market`, `read_positions`, `read_mandate`, `calculate_signal`, `quote`, `propose_paper_order`, and `hold`. A model can request a named tool with typed arguments; dispatcher code checks the agent identity, selected configuration, permitted symbols, bounds, freshness, call budget, and tool authorization before executing. Do not give the model arbitrary URL, shell, private key, raw signing, contract-call, or live order submission tools. Treat headlines and other external content as untrusted data, even when returned in JSON; validate every proposed action at the trusted tool boundary. See [OWASP's prompt-injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) and [agent authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html).

Runs must be serialized per agent, including across worker processes, with a durable lease or transactional claim and bounded retry/backoff. Persist run ID, scheduled time, configuration version, observations with provenance, model/tool inputs and outputs as appropriate, decisions, rejects, and side effects. Enforce idempotency at each external side effect; a crash can occur after a service executes an order and before the worker records success. Reconcile by order ID or venue idempotency key before retrying, rather than assuming a timeout means failure. Restart and stale-lease recovery should not create duplicate exposure. [Temporal's retry documentation](https://docs.temporal.io/encyclopedia/retry-policies) describes why activities must tolerate re-execution; a database-backed worker is sufficient for an initial implementation if it enforces equivalent invariants.

## Paper futures and live execution

The existing Flash order path is spot-only and the on-chain checks do not model derivatives. A paper futures harness must use a separate clearly labelled ledger, isolated per agent, with no real order or signing path. A credible simulator should specify contract type and settlement, side, quantity, leverage and margin, mark/index prices, fees, funding, realized and unrealized P&L, maintenance margin, and liquidation assumptions. Where these are unavailable, explicitly disclose the simplification rather than present simulated P&L as a venue-equivalent result. Leveraged futures amplify price movements and can lose more than initial margin; see the [CFTC virtual-currency advisory](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/understand_risks_of_virtual_currency.html).

Do not extrapolate the existing spot CPPI gate or a paper ledger into a principal guarantee for futures. The present repository has specific live-order gaps that must be addressed and independently reviewed before automated live activation:

1. `RiskGate.approveOrder` checks the relation between an order digest and intent only when the optional `orderHasher` is configured; the sample deployment does not configure one. The bracket digest also needs explicit binding to its checked terms.
2. `_verifyTee` verifies a permitted signer over response bytes, but does not bind that response or `chatIdHash` to this particular order or mandate. A signed model response is provenance evidence, not evidence that risk checks apply to the signed order.
3. `loadBars` falls back to synthetic prices after market-data failure. Synthetic data must never drive a live entry. Live exit handling also needs actual venue submission and reconciliation before a position is reported closed.

The gate's other assumptions, including price attestation, quote construction, allowance, and how stops are verified at the venue, need end-to-end adversarial tests and security review. No autonomous configuration compiler or harness should bypass the gate or imply that a stop guarantees execution at a given price.

## Useful implementation sequence

1. Introduce an immutable agent ID and per-owner configuration store with verified wallet sessions, schema validation, template list, and explicit draft review. Preserve public demo discovery separately from owner-scoped management.
2. Wire only supported strategy parameters into the deterministic strategy engine. Add tests that different versions change actual decisions, and unsupported custom text cannot silently become a different strategy.
3. Add a bounded, single-flight paper harness with isolated state, testable clock and tool adapters, run history, data freshness checks, and restart/idempotency tests. Clearly identify simulated knowledge and executions in the UI/API.
4. Implement per-agent deployment and live activation only after ownership proofs, real venue lifecycle reconciliation, digest and bracket binding, risk controls, and external review are complete. Owner consent should identify the exact configuration and scope of delegated authority.
