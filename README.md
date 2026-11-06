# Perpetua

**Principal-protected agents that pay for their own brains.** ETHGlobal Mumbai 2026.

Perpetua is an on-chain principal-protected note (Endowment-CPPI) managed by an AI agent. The agent has to earn its own inference bill. Its risk limits are enforced on-chain by **RiskGate**, a deterministic smart contract, not by trusting the AI.

## Ethereum chain and RPC registry on Arkiv

For **Mirror something Ethereum depends on**, the project mirrors all **2,855 EIP-155 chains** and **4,219 unique RPC endpoints** from the MIT-licensed [ethereum-lists/chains](https://github.com/ethereum-lists/chains) registry. Chains and RPCs are separate indexed Arkiv tables, published as complete, versioned snapshots with source commit, hashes, license and writer provenance. The project itself resolves remote RPCs, including 0G's blockchain RPC, through Arkiv and verifies the returned chain ID. Source endpoints are not silently substituted if Arkiv is unavailable.

**Rabdi creator and initial owner:** `0x0f531Abb28A54435a5848AA70deF32040E2A2e65` · chain ID **7794095**. [Deployment metadata](arkiv/registry-deployment.json) · [source license/attribution](arkiv/THIRD_PARTY_NOTICES.md) · [project MIT license](LICENSE) · [AI disclosure](AI_DISCLOSURE.md).

```sh
pnpm registry:query chain 16602       # read 0G metadata/RPC entities directly from Arkiv
pnpm registry:query resolve 16602     # Arkiv discovery + live chain-ID verification
pnpm registry:import --dry-run        # reproduce full-source validation without spending gas
pnpm registry:import                  # funded importer; resumes safely after interruptions
```

To browse our chain entities in the [Rabdi explorer](https://rabdi.explorer.arkiv.network/entity-explorer), run:

```text
arkiv.schema = str('ethereum-registry.chain.v1') AND $creator = addr(0x0f531Abb28A54435a5848AA70deF32040E2A2e65)
```

Add `AND chain_id = u64(16602)` for one chain, or change the schema to `ethereum-registry.rpc.v1` for endpoint entities. These broad explorer queries include older unexpired snapshots; the application reads the active completed snapshot. Creator identifies who originally published an entity even after a transfer; its current owner can still change or delete it.

Reads need no writer key or Perpetua account. The local public API is `GET http://localhost:8787/registry/chains?chainId=16602`; it has no wallet/session requirement. The signed-in app has a **Chain registry** table at `/registry`. SDK schemas and direct queries work independently of our API. Anonymous Arkiv RPC has a quota; readers can obtain their own optional access key from Arkiv Hub.

The registry page also shows optional per-RPC health observations collected by our monitor: sampled availability, latency, HTTP status and chain-ID validation, with per-endpoint graphs. The observations live on the monitor host, not Arkiv. They are not an SLA. Start or inspect the local service with `pnpm registry:health-service install` / `pnpm registry:health-service status`. See [methodology and limitations](docs/rpc-health.md).

Track files: [schema](arkiv/schema.md), [feedback](arkiv/friction.md), [reach](arkiv/reach.md), [why Arkiv](arkiv/why-arkiv.md), [data quality](arkiv/data-quality.md). [Full operation and RPC integration guide](docs/chain-registry.md). The earlier Signature Atlas remains a separate dataset; this registry is sourced from ethereum-lists, not Sourcify.

- **The AI proposes, RiskGate disposes.** The LLM, running on 0G Compute with TEE-signed output, proposes trades. RiskGate computes F, C and E from live vault state and a fresh Flash price, then approves or rejects each order. The agent's EIP-1271 wallet signs only approved Flash orders.
- **Survival-CPPI.** F = π·P + R, C = max(V − F, 0), E = min(m·C, E_max). Only the cushion can ever be risked, so the agent cannot trade itself to death.
- **A metabolism.** Runway decides the model tier: Thrive (large model) → Frugal (small model) → Starving (rules only) → Hibernate. It moves back up when income lands.
- **Six income engines, no human top-ups:**
  - paid signals and risk checks over x402;
  - Flash integrator fees from copy-traders;
  - management and performance fees (priced cost-plus against the live 0G price);
  - keeper bounties;
  - stable-pool LP;
  - safe-leg yield.

  Harvested income is swapped into native 0G locally and bridged with **Chainlink CCIP** into a ComputeTreasury on 0G Chain. The agent then deposits it into its own 0G compute ledger.
- **Everything public lives on Arkiv:** signals (commit-reveal), trades, decision logs, the hourly income ledger and leaderboard snapshots. Arkiv also hosts the **Signature Atlas**, a provenance-carrying mirror of Ethereum's function and event signatures.

> Hackathon prototype. Not financial advice. See [Known trade-offs](#known-trade-offs-and-open-risks-stated-not-hidden).

## Shared live market data on Arkiv

`pnpm market` continuously mirrors BTC/ETH/LINK USDT futures quotes, top-20 books, mark/index prices, funding, open interest and closed 4h candles into Arkiv. Collection targets 5 seconds; publication targets 15 seconds with 7-day sampled history. `pnpm market:query BTCUSDT` reads a fresh, owner-filtered observation back from Arkiv. A macOS service is installed locally for automatic restart; it runs while the host is awake. See [service setup, health, schemas and recovery](docs/market-mirror.md).

## Configurable agents and hosted runtime

Open **http://localhost:3000** and sign in with MetaMask. The dashboard lists only your agents; the leaderboard lists agent names and cumulative profits. Create multiple agents, select a strategy and limits, then add local test funds and deposit through MetaMask. The backend deploys isolated local contracts and keeps spot agents running without the browser open.

Each agent shows its transaction history and current investments, including losing positions. Withdraw individual allocations or withdraw all, including protected lending; underfunded agents sleep. The local product integration check exercises real Anvil token settlement and wallet payouts: `pnpm exec tsx scripts/local-product-smoke.ts` while the API and Anvil are running.

Local trading and inference use synthetic data, mock tokens and simulated AI. The funded Arkiv Signature Atlas importer is live on Rabdi. Live 0G prompt compilation, derivatives execution and cross-chain deployment still require their provider/venue/network setup. See [runtime and setup](docs/agent-platform.md), [withdrawals](docs/withdrawals.md), [research](docs/research/futures-strategies.md), and the [paid WebSocket idea](docs/future-scope.md).

---

## What's verified in this repo

| | status | how |
|---|---|---|
| CPPI math, vault, RiskGate, AgentWallet (EIP-1271), HarvestRouter (CCIP), ComputeTreasury, AgentRegistry | ✅ **45/45 Foundry tests** incl. fuzz | `pnpm test:contracts` |
| Spec's worked example on-chain: P=1000, π=95%, R=10 → **F=960, C=40, E=120** | ✅ | `RiskGate.t.sol`, live on anvil |
| Unit-economics table (Bear −2.17 / Base 52.96 / Bull 507.71; burn 11.40 / 9.60) and break-evens (16 signals/day, 64 checks/day, $4,800 copied/month, $2,560 endowment) reproduced exactly | ✅ **19/19 vitest** | `pnpm --filter @perpetua/core test` |
| Full money loop end to end on real contracts (local anvil): reckless trade reverted on-chain → bracket trade approved and settled through the capped allowance → starvation ladder → income → poke() harvest → swap → CCIP → ComputeTreasury → 0G ledger → tier back up | ✅ | `pnpm demo` writes `.perpetua/evidence.json` |
| x402 API (`/v1/signal`, `/v1/risk-check`, free reads, copy-trade proxy) | ✅ smoke-tested (dev mode, unpaid) | `pnpm api` |
| Arena (Next.js 16): agents, CPPI gauges, runway bars, leaderboard, copy flow, Atlas explorer, proof page | ✅ `next build` passes | `pnpm arena` |
| Signature Atlas import against **live** 4byte + OpenChain + live Base/Arbitrum/Ethereum calldata | ✅ dry run: 295 rows, 85 decode-verified | `pnpm atlas:import` |
| Backtest, 1 year of real 4h LINK/ETH after costs | ✅ see [Backtest](#backtest-honest) | `pnpm backtest` |
| **Needs live keys and a day-one check:** Flash mainnet orders from the AgentWallet, 0G live inference and TEE signature fetch, CCIP $0G CCT lane, Arkiv writes, x402 settlement, X posts, Privy | ⏳ code paths written against the real APIs; see [Going live](#going-live-day-one-checklist) | |

---

## Architecture

```
                 ┌───────────────────── vault chain (Flash-supported, e.g. Base) ─────────────────────┐
 depositor ──►   │ PerpetuaVault (ERC-4626, F = π·P + R)  ──floor──►  safe leg (Aave v3 / MockLending)│
                 │      │ fundWallet / pullFromWallet (RiskGate only)                                 │
                 │      ▼                                                                             │
 keeper ─poke()─►│ RiskGate ── marks V, F, C, E (fresh signed Flash price ≤60s) ── wallet ≤ E          │
                 │      │ approveOrder(intent, price, 0G TEE proof) → digest approved                  │
 agent  ─propose►│      ▼                                                                             │
 (0G brain)      │ AgentWallet (EIP-1271: valid only for approved digests) ──► Definitive Flash /order │
                 │      │ harvest(): fees pay compute first, then surplus                              │
                 │      ▼                                                                             │
                 │ HarvestRouter: USDC → $0G (swap) → Chainlink CCIP ─────────────┐                    │
                 └────────────────────────────────────────────────────────────────┼────────────────────┘
                                                                                  ▼
                 ┌──────────────── 0G Chain ──────────────────┐          ┌──────── Arkiv (Rabdi) ────────┐
                 │ ComputeTreasury (CCIPReceiver, daily cap)  │          │ agent / signal / trade /      │
                 │      └─► agent wallet → broker.ledger      │          │ risk-check / mandate / ledger │
                 │           .depositFund → TEE inference     │          │ decision-log / leaderboard    │
                 └────────────────────────────────────────────┘          │ Signature Atlas (4byte mirror)│
                                                                          └───────────────────────────────┘
```

- **Contracts** ([contracts/src](contracts/src)), one narrow job each:
  - [PerpetuaVault](contracts/src/PerpetuaVault.sol): ERC-4626 vault plus CPPI accounting.
  - [RiskGate](contracts/src/RiskGate.sol): the only risk authority. Public `poke()`, `approveOrder()`, and `checkOrder()` (the same logic the paid risk-check API runs).
  - [AgentWallet](contracts/src/AgentWallet.sol): EIP-1271 signer. It also supports Flash's EIP-191 cancel message, with the hash derived on-chain from the canonical text.
  - [HarvestRouter](contracts/src/HarvestRouter.sol): swap-then-CCIP.
  - [ComputeTreasury](contracts/src/ComputeTreasury.sol): CCIP receiver; credits only what actually arrived; replay- and epoch-deduplicated.
  - [AgentRegistry](contracts/src/AgentRegistry.sol): stake bond, locked risk tier, death certificates.
  - [CPPIMath](contracts/src/libraries/CPPIMath.sol): the pure math.
- **Agent runtime** ([agent/src](agent/src)):
  - [agent.ts](agent/src/agent.ts): the loop.
  - [zerog.ts](agent/src/zerog.ts): 0G broker in direct mode, three spend caps, TEE proof.
  - [flash.ts](agent/src/flash.ts): REST client built from Flash's OpenAPI spec.
  - [prices.ts](agent/src/prices.ts): EIP-712 price attestations.
  - [records.ts](agent/src/records.ts): Arkiv records.
- **Shared core** ([packages/core](packages/core/src)): CPPI mirror, indicators, signal engine, degradation router, leaderboard scoring, unit economics, ABIs.
- **API** ([api/src/server.ts](api/src/server.ts)): x402 v2 (`@x402/express`).
- **Arkiv** ([arkiv](arkiv)): schemas, batching writer, Atlas import pipeline, queries, and the five required docs: [schema](arkiv/schema.md), [friction](arkiv/friction.md), [reach](arkiv/reach.md), [why-arkiv](arkiv/why-arkiv.md), [data-quality](arkiv/data-quality.md).
- **Arena** ([frontend](frontend)): Next.js + Tailwind. It reads RiskGate on-chain directly and never trusts the agent's own number.
- **Scripts** ([scripts](scripts)):
  - `deploy-local.sh`, `demo.ts`, `keeper.ts` (poke bot);
  - `backtest.ts`;
  - `measure-0g-cost.ts`, `measure-gas.ts` (day-one measurements);
  - `forward-income.ts` (x402 revenue → `vault.recordIncome`);
  - `export-abis.ts`.

---

## Running the current app

See the [local walkthrough and integration status](docs/local-walkthrough.md) for exact UI steps, simulation commands, live Arkiv queries, restart behavior and remaining live integrations. `pnpm api:sim` runs the complete local wallet/trade/withdrawal exercise; it does not change saved live credentials. `pnpm check:local` verifies that flow against the running simulation API.

## Quickstart (local, no keys needed)

Requires Node ≥ 22.10, pnpm 10, and Foundry (`brew install foundry`).

```bash
pnpm install
pnpm setup:contracts          # forge-std v1.9.6 + OpenZeppelin v5.1.0 into contracts/lib, forge build
pnpm test:contracts           # contract tests
pnpm --filter @perpetua/core test

anvil                          # terminal 1
pnpm deploy:local              # deploys 3 agents (Atlas/Halcyon/Ember) + treasury + CCIP simulator
pnpm demo                      # the 3-minute demo, scripted; writes .perpetua/evidence.json
pnpm api                       # terminal 2: http://localhost:8787
pnpm arena                     # terminal 3: http://localhost:3000
pnpm agent                     # optional: run Atlas's live loop (sim Flash/0G by default)
pnpm keeper                    # optional: poke() bot
```

The local run is disclosed as such:
- Flash and 0G run in **sim mode**. They use the same request and response shapes and the same digest → RiskGate → EIP-1271 pipeline, but no external venue.
- CCIP is a local simulator that calls `ccipReceive` exactly as the real OffRamp would.
- `MockLending` can be time-accelerated (`LENDING_TIME_MULTIPLIER`).
- Demo payers are local anvil accounts.
- The anvil private keys in `scripts/` are Foundry's public dev keys.

---

## Demo script (< 3 min) and where each beat comes from

| time | beat | what `pnpm demo` does / shows |
|---|---|---|
| 0:00 | Hook | Three agents with runway and CPPI gauges (Arena `/`) |
| 0:20 | Safety proof | A $500 order against E = $120 gets `checkOrder → EXCEEDS_EXPOSURE`. **The reverted `approveOrder` tx lands on-chain**, and `AgentWallet.isValidSignature` returns `0xffffffff` |
| 0:50 | Real trade | LINK bracket (SL −8%, TP +16%), backed by a TEE-signed inference: RiskGate approval tx → EIP-1271 valid → Flash order → settled via the capped allowance → X post |
| 1:30 | Starvation | The ledger drains: Thrive → Frugal → Starving, then "I'm hungry." Nothing crashes, and stops stay live on-chain |
| 2:10 | A judge feeds it | Copy-trade fee + x402 signal + hackathon income → `poke()` harvest → swap to $0G → **CCIP message id** → ComputeTreasury credit → `withdrawForLedger` → ledger deposit → back to Thrive |
| 2:40 | Close | `/proof` renders every tx hash and request id |

For the live demo (Base mainnet + 0G Galileo), a judge copies with $1 and another team's agent buys a signal. Record a backup run the night before; see `demo_backup_plan`.

---

## Seed funds and the "no human top-up" rule

- **Seed (one time, at deploy, disclosed):**
  - 1,000 USDC per agent vault (`Deploy.s.sol`);
  - the MockLending yield reserve and the mock swap's 0G liquidity (testnet only);
  - 1 ETH of CCIP fee gas in the HarvestRouter (counted as burn);
  - the 0G ledger minimum of 3 0G (`addLedger`);
  - optionally `ComputeTreasury.seed()` as the cold-start hibernation reserve. It is the only non-CCIP credit path, and it emits `Seeded`.
- **After setup:** every transfer into the vault comes from an income engine (`IncomeRecorded` events), from realised PnL (`WalletPulled.realisedProfit`), or from yield. Every credit to ComputeTreasury comes from a CCIP message (`HarvestCredited`). An auditor can check this from the event logs alone.
- 0G track disqualifiers we avoid:
  - Perpetua is not a token launch with a chatbot attached;
  - there is no revenue from the team trading its own token;
  - no human refills the agent;
  - no CCIP usage is claimed without a real CCIP Explorer message.

---

## Sponsor tracks: what to show

| prize | requirement | how Perpetua meets it | proof to collect |
|---|---|---|---|
| **Definitive**: Flash advanced orders in a social app | working advanced orders, on-chain execution, demo video tagging @DefinitiveFi | agent bracket orders (entry + attached SL/TP) from an EIP-1271 AgentWallet; follower copy orders with `flashIntegratorFeeBps` | Flash order IDs, Base tx hashes, a judge's live $1 copy |
| **0G**: Agents That Pay for Themselves | full loop with tx hashes and request IDs, unattended, spend caps, graceful degradation | earn → poke() harvest → CCIP → ComputeTreasury → ledger → TEE-verified inference. Spend caps: runtime token budget, sub-account top-up limit, treasury daily cap. 4-tier ladder | ledger before/after, chat IDs, tier switch on screen, no top-up |
| **Arkiv**: mirror something Ethereum depends on | licensed public data, re-runnable import, a used feature reads it, five docs | Signature Atlas (4byte, cross-checked with OpenChain, decode-verified), read by `/v1/risk-check`, the signal engine and the Arena `/atlas` | importer wallet, `import-run` entities, `pnpm --filter @perpetua/arkiv query stale` |
| **Chainlink**: Best use of CCIP 2.0 | real CCIP token/message transfer | every harvest swaps multi-token income → native $0G CCT → CCIP → ComputeTreasury on 0G (0G's own canonical rail) | CCIP Explorer message link, source swap tx, destination credit tx, CCT pool addresses |

Chainlink CRE and Data Feeds are **intentionally not used**. RiskGate is the only risk authority, and the Flash price is the only price input.

---

## Going live: day-one checklist

These were open technical risks in the spec. Each is resolved or narrowed here, or still needs a live check.

1. **Flash order from a smart wallet.** Flash validates EIP-1271 whenever `funderAddress` has code. It also re-checks on cancel (EIP-191 message; we support it via `AgentWallet.approveCancel`).
   - *Still to confirm:* whether Flash re-checks `isValidSignature` at **fill** time. That's why exit approvals live for 30 days, while entry approvals die with their mandate epoch.
   - *Still to confirm:* the `attachedBracket` submit shape against a live quote. We send `userSignature`, `deadline`, `signedMaxFromAmount`, the `salt`, and the echoed typed data.
   - Set `FLASH_SPENDER_ADDRESS` to the spender inside a live quote's `evm.approveTx`. The agent logs it on every quote.
2. **Flash's EIP-712 struct is server-built (opaque).** RiskGate can't yet recompute the digest from the intent, so the spec's fallback is live: the allowance to Flash rises only by `amountIn` per approved order, capped at E, and the wallet never holds more than E. When the struct is pinned, plug an on-chain hasher into `RiskGate.setOrderHasher()`.
3. **Flash quotes are unsigned.** A relayer key (`PRICE_SIGNER_PRIVATE_KEY`) signs `(asset, priceE8, timestamp)` from a fresh Flash quote as EIP-712. RiskGate rejects prices older than 60 s or from the future, and checks the order's own implied price against the attestation (≤1.5% deviation).
4. **0G TEE proof on-chain.**
   - RiskGate verifies an EIP-191 signature over the exact response text by an allow-listed TEE signer (`setTeeSigner`). That's the same check `processResponse` runs off-chain.
   - The agent fetches `{text, signature}` via `InferenceVerifier.fetchSignatureByChatID`. *Confirm* it against the chosen provider.
   - Allow-list each provider's `teeSignerAddress` from `checkProviderSignerStatus`.
5. **Third-party 0G ledger deposits.** SDK v0.9.0 exposes `ledger.depositFundFor(recipient, amount)`, so a funder *can* deposit into another wallet's ledger. We still route through the agent's own wallet (`withdrawForLedger` → `depositFund`), because it keeps the daily cap on-chain.
6. **CCIP lane.** Confirm which source chains have a live $0G CCT pool and lane into 0G Galileo or mainnet. Set `ZEROG_CCT_ADDRESS`, `CCIP_ROUTER_ADDRESS` and `OG_CHAIN_SELECTOR`, deploy [DeployTreasury.s.sol](contracts/script/DeployTreasury.s.sol) on 0G, then `MODE=vault forge script script/Deploy.s.sol`.
7. **Measure, don't guess.** Run `tsx scripts/measure-0g-cost.ts` and `tsx scripts/measure-gas.ts`, then replace the constants in `.env` and `packages/core/src/economics.ts`.
8. **comfy (optional compute-share).**
   - Register: `npx -y comfy-cli@latest agent register --name Atlas --description "…" --owner <wallet>`.
   - Claim within 15 min, then run `agent register --complete <id>`.
   - Launch at comfy.fun/launch with compute-share **on**. Make sure the 0G account bills in **0G, not USD**.
   - Mint a capped key: `compute key mint --agent <id> --limit-og <daily>`. The runtime already reads its own ledger before every call and steps down the ladder instead of erroring.

---

## Backtest (honest)

`pnpm backtest`: rules only (sentiment factor 0), 1 year of real 4h bars from 2025-11-06 to 2026-11-05. Costs are 0.4% round trip. Brackets are SL 2×ATR and TP 4×ATR. When a bar spans both levels, the stop is assumed to fill first.

| | trades | win rate | avg R | NAV return | max DD (NAV) |
|---|---|---|---|---|---|
| LINK | 11 | 45% | +0.26R | +2.8% | 3.3% |
| ETH | 2 | 0% | −1.12R | −2.2% | 2.2% |
| combined | 13 | 38% | +0.05R | +0.5% | 4.3% |

This is roughly breakeven, and that's the point: **trading is upside, not food.** The agent trades rarely, CPPI caps the downside, and services pay the bills. A modest, honest backtest beats a hockey stick. Paper-trade for 48 hours before the demo with `FLASH_MODE=sim pnpm agent`.

## Unit economics (planning assumptions, reproduced in `economics.ts`)

| scenario | total income | income w/o trading | burn | covers burn |
|---|---|---|---|---|
| Bear | −$2.17 | $12.83 | $11.40 | only if trading pauses (1.1×) |
| Base | $52.96 | $52.96 | $9.60 | 5.5× |
| Bull | $507.71 | $492.71 | $9.60 | 53× |

---

## Known trade-offs and open risks (stated, not hidden)

- **Gap risk** is CPPI's structural weakness. A price gap larger than 1/m between refreshes can breach the floor. Mitigations:
  - every entry carries a Flash stop inside 1/m (enforced on-chain);
  - m ≤ 4 (enforced);
  - `highVolMode` shortens the poke interval.
- **The one external price input is Flash's own quote.** Enforcement and execution use the same number, but the price relayer key is a trust point until Flash signs quotes.
- **Counterparty risk.** Flash is in beta, stops depend on Definitive's monitoring, and the safe leg carries lending-protocol risk. Principal protection holds against bad trades, not against a hack of these.
- **Comingled capital is avoided.** Follower vaults (`isFollowerVault`) get their own ledger, floor and RiskGate instance.
- **Fees are bills first.** Management and performance fees pay the compute bill first; only the excess becomes `ownerClaimable`. The vault's own surplus stays in NAV.
- **Partially enforced on-chain.** Consecutive-loss half-sizing and the stop-presence check live in the runtime and keeper; RiskGate only lets the proposer *tighten* flags. The daily-loss halt (−20% of cushion → 24h) and the drawdown breaker (−30% from the cushion peak → services only) are fully on-chain.
- **Leaderboard in the Arena.** Scores are recomputed client-side from runtime state. The canonical series is the Arkiv `LeaderboardSnapshot`, written by `arkiv/src/leaderboard-snapshot.ts` after each keeper cycle.
- **Copy trading** sits in a legal grey area. The prototype has caps ($100), disclaimers and a full track record, and followers keep custody.

## How AI was used
- **In the product:** a 0G-hosted LLM scores sentiment and writes reasoning. All entry, sizing and risk rules are deterministic code, and RiskGate never runs an LLM.
- **In the build:** this repository was implemented with an AI coding agent (Claude Code), working from a written build spec. The spec's open risks were checked against the real Flash OpenAPI spec and the 0G, Arkiv and x402 SDK type definitions.

## Licences and data
- Code: MIT.
- [4byte.directory](https://www.4byte.directory/): open data, freely searchable and scrapable.
- [OpenChain](https://openchain.xyz/signatures): used only for per-selector cross-checks.
- No Sourcify-hosted data is imported.

## Evidence checklist (fill in for the live run)
- Contract addresses (vault chain + 0G): `contracts/deployments/*.json`
- Seed deposit tx (the only human-funded transfer):
- RiskGate rejected-trade tx · approved-order tx · Flash order ID · Base settlement tx:
- poke()/harvest tx · CCIP message ID (CCIP Explorer link) · ComputeTreasury credit tx:
- 0G ledger deposit tx · inference chat/request IDs (TEE verified) · tier-switch screenshot:
- x402 buyer addresses (`.perpetua/x402-buyers.jsonl`) · judge copy-trade order ID:
- Arkiv importer wallet · import-run entity keys · agent wallets (ownedBy):
