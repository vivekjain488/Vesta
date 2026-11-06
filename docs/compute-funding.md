# Compute funding workflow

The agreed initial allocation is **20% of the first deposit, capped at 5 USDT/USD equivalent**. Compute capital and trading capital are separate. Later deposits do not restart the bootstrap calculation. A later refill uses up to 20% of cumulative net realized trading profit that has not already funded compute, and only while compute is below the selected model's threshold.

| Initial deposit | Compute allocation | Trading allocation |
| --- | --- | --- |
| $10 | $2 | $8 |
| $25 | $5 | $20 |
| $100 | $5 | $95 |

`splitAgentDeposit` in `packages/core/src/compute-funding.ts` implements this calculation using integers. USD uses six decimals; native 0G uses eighteen. The $5 cap applies to the **initial allocation**. The default independent rolling 24-hour conversion cap is also $5, configurable by the operator. The profit share is a chosen 20% default, rather than an assumption that every refill needs the full allowance.

## What is implemented and what is pending

Implemented: allocation math, per-model low-water/target thresholds, mandatory funding priority, quote/budget checks, durable per-agent reservations, recovery across restarts, an optional bounded model advisory call, a live spot-runtime entry gate, owner-only funding status, and an atomic treasury-to-ledger contract function with operation replay protection. These have unit and contract tests.

**The running MetaMask deposit still calls the existing trading vault directly. It does not yet execute the new split. No verified live bootstrap swap/CCIP adapter is bundled or configured.** Do not present existing deposits as split or their compute as self-funded. Live spot workers now wait with `compute_funding_adapter_required` until a trusted adapter is installed; local simulated trading remains available. The separate paper futures harness does not submit real trades and does not execute this funding flow.

The API exposes `GET /v1/agents/:agent/compute-funding` after MetaMask login and ownership verification. The runtime also includes a `computeFunding` entry in its state. Journals are stored in `.perpetua/compute-funding-<agent-id>.json`. A receipt for a swap or CCIP send is not treated as verified inference credit.

## Deposit and activation

1. The backend quotes the accepted input asset using a fresh executable route. For USDT, USDC, ETH or another supported asset, normalize the confirmed deposit to USD equivalent using token decimals and verified pricing. “Any currency” means an explicitly supported token/chain pair with liquidity; it is not permission to invoke arbitrary token contracts.
2. Before moving money, show the deposit amount, `min(20% × deposit, $5)` compute allocation, remaining trading amount, minimum native 0G to receive, route costs and destination ledger owner. Bind these terms, expiry, chain IDs and an operation ID to the owner's signed deposit action.
3. A deposit coordinator must segregate the compute allocation **before** depositing the trading portion into `PerpetuaVault`. No model call is needed for this calculation. Only the trading portion becomes vault principal/shares. The current direct-to-vault deposit flow must be replaced before enabling this live.
4. Quote all gas, swap and bridge costs within the allocation; retain distinct gas reserves on the source and destination. A gas sponsor may advance native gas, but its reimbursement must be included in the quoted cost and attributed to this agent. Never deposit the wallet's entire native balance into inference credit.
5. Check the real ledger creation and provider activation minimums. The installed 0G SDK requires 3 native 0G to create a ledger, and provider sub-accounts have their own minimum allocation. Keep these checks dynamic. If a capped allocation cannot activate the selected model after fees, return `bootstrap_cannot_meet_provider_minimum`; do not spend more than the approved allocation or lock a partial unusable credit. An existing ledger can have different incremental requirements.
6. The adapter converts the allocation through a verified route and reconciles all receipts. It funds the compute ledger for this agent's backend wallet, then allocates bounded credit to acknowledged providers. Only after the ledger/provider credit is confirmed and a fresh balance clears the model threshold may new trading start. The platform's initial setup funds must be labeled as a platform seed, not agent-earned revenue.

The protected percentage in the existing vault applies to **trading principal**, not the original gross wallet deposit. Compute purchases, conversion fees and consumed inference cannot be advertised as protected principal. An $8 trading allocation also needs a compatible minimum-capital setting, position minimums and reserve configuration; the current templates/local vault fixture are not yet calibrated for an $8 live account.

## Before every trading evaluation

The server performs these checks independently of the model:

1. Owner sleep/withdrawal takes priority: no new conversion, allocation or paid inference.
2. Reconcile any existing funding operation. A pending/unknown operation keeps new entries paused and cannot be replaced by a second purchase. Deterministic stops, reduce-only exits and withdrawals remain available.
3. Read conservative usable compute credit: available ledger credit plus usable credit of the selected providers, minus unsettled inference liabilities and pending refunds. Native wallet gas is not compute credit. Do not count a provider balance twice through the ledger's `totalBalance`.
4. Select the small/large model using the agent's allocated capital and model policy. Each model profile has a funding trigger, a higher replenishment target and a reservation for one funding-only model call. Operator configuration must map those tiers to the actual chosen provider/model and measured prices.
5. If credit is above the trigger and bootstrap is complete, allow normal strategy evaluation. Below the trigger, enter funding mode and stop new trading entries.
6. If enough credit remains, request one bounded 0G funding advisory call. Its only task is to explain the required `fund_compute` action. The model cannot change recipients, route, amount, limits or choose a trade instead. The controller reserves the advisory attempt before the call; a timeout/restart never causes an automatic second billed call. The adapter must enforce the supplied cost/output limits and abort signal.
7. If the call cannot be afforded, is unavailable or fails, deterministic funding policy continues. A model cannot be the sole mechanism that rescues its own empty compute account.

The default tier thresholds are **operating defaults, not measured provider prices**:

| Model tier | Trigger below | Refill target | Maximum advisory reservation |
| --- | --- | --- | --- |
| Small | 0.25 0G | 1 0G | 0.01 0G |
| Large | 0.75 0G | 2 0G | 0.03 0G |

Calibrate thresholds from bounded request costs, intended evaluation cadence and observed funding latency before activation. Keep enough runway to complete a bridge/retry cycle; do not wait until the last inference is spent. A policy downgrade can select the cheaper model when capital/credit allows it; it cannot bypass funding reservations or owner sleep.

## Refilling from profit

The allowance is `max(0, 20% × cumulative net realized trading profit − profit funding already reserved/spent)`. Cumulative net realized trading profit includes trading losses, trading fees and perpetual funding, and excludes deposits, unrealized PnL and compute purchases (which are accounted separately). This prevents reusing the same profit after every tick or after a loss/recovery cycle.

The conversion amount is bounded by this allowance, eligible realized-profit cash, the remaining daily funding budget and an executable quote. Quote only what is needed toward the model target. A smaller refill may proceed if it at least clears the model trigger. A quote that cannot clear the threshold waits instead of repeatedly paying small transaction fees. The controller applies a 15-minute cooldown, a $0.10 minimum conversion, 1% maximum slippage and 5% maximum all-inclusive route fees by default.

Example: $10 of cumulative realized trading profit permits up to $2 of compute funding. If $1.20 has already been reserved/spent, at most $0.80 remains eligible. If there is no eligible profit and compute is low, keep entries paused and preserve exits. Never sell a losing position or debit protected principal to refill compute without a separate owner-authorized operating-budget policy.

## Conversion and settlement

The desired asset path is `segregated bootstrap cash / realized-profit cash → verified swap and cross-chain route → native 0G → agent compute ledger → provider inference credit`.

There are two route shapes. Swap to a supported 0G cross-chain token on the source, bridge it and unwrap on 0G; or bridge a supported settlement token and swap it for native 0G at the destination. Choose only a route whose token pool, lane, addresses, destination DEX liquidity and all-inclusive minimum output are verified. CCIP transports supported assets and messages; it does not perform a currency conversion by itself. Its native fee token list is not a list of bridgeable assets.

The existing `HarvestRouter` implements the first shape for harvested income. It assumes a source-side 0G CCT pool; that assumption is **not** a verified live route. It also does not segregate a first deposit. Its current periodic harvest must be coordinated with demand-based reservations before activation; do not run it as an independent second funding mechanism. Existing local Anvil routing uses mock swaps and CCIP delivery.

`ComputeTreasury.fundLedger(agentId, operationId, amount)` atomically unwraps received W0G and calls the configured 0G ledger's payable `depositFundFor(operator)`. A failed unwrap/deposit rolls back treasury credit, daily spending and operation state. An already-funded operation ID cannot pay twice, including when the runtime lost the first receipt. This support exists in installed SDK 0.9.0; the previous assumption that contracts cannot deposit for another wallet was incorrect. Configure the canonical ledger manager, unwrap support and the correct operator before use. These changed contracts have not been deployed over the current local fixture or to a live network.

The adapter should use the durable intent ID for replay protection on **every value-moving step**, not just the final ledger deposit. Persist signed transaction hashes/nonces before broadcast or use an on-chain operation ID. On restart, reconcile chain receipts, CCIP message state and destination credit. A timeout means unknown; a failed bridge does not mean the funds returned to the source. Recovery continues under the same reservation. Expired quotes can be cancelled only when receipt reconciliation proves nothing started.

## Withdrawal and sleep

Owner sleep/withdrawal stops new funding actions and model calls. A transaction already broadcast may still settle; reconcile it and keep the owner informed. Full withdrawal must include trading holdings/protected lending and separately reconcile unspent operating cash, native 0G and refundable compute credit. Already consumed inference is an expense. Provider credit may have refund locks, so its asynchronous refund must remain visible until returned; do not report a full financial withdrawal complete while unspent funds remain pending. Current local full withdrawal handles the trading vault/holdings; compute refunds need the live adapter.

## Adapter and activation requirements

`COMPUTE_FUNDING_ADAPTER_MODULE` is a trusted server-local module exporting `createComputeFundingPort(cfg)`. Its contract is in `agent/src/compute-funding.ts`: `observe`, `quote`, `reconcile`, `advance`, and optional bounded `fundingAdvice`. The adapter must recheck withdrawal state, available cash, current quote/cost constraints and gas immediately before every transaction. It must use isolated agent ledger owners or an explicitly audited per-agent pooled accounting scheme; the current shared local compute key is not production isolation.

The journal uses atomic local-file replacement and a process-local worker guard. Run one backend process per agent/state directory. Multi-host operation requires database transactions/leases and durable receipt indexing. Runtime funding records currently remain local; publishing them as per-agent Arkiv audit records requires funded agent writer identities. The market mirror's funded identity is a separate service.

The Router inference API key is a different payment account from a direct SDK ledger. This workflow currently refuses Router mode: a Router integration needs its own verified account-read/payment adapter. Buying native 0G and depositing to the direct ledger does not fund the Router API key. The configured direct testnet wallet still needs actual bootstrap funds/provider validation; testnet tokens cannot pay mainnet inference.

Verified references (6 November 2026): [0G broker/compute flow](https://build.0g.ai/compute), [funding and ledger minimum](https://build.0g.ai/funding), [current Galileo CCIP directory](https://docs.chain.link/ccip/directory/testnet/chain/0g-testnet-galileo-1). The old Galileo selector is inactive; never reuse a historical selector merely because it is in a local test fixture.

Run `pnpm funding:preview 10` to inspect the allocation without moving funds. Run `pnpm --filter @perpetua/core test` and `pnpm test:contracts` to verify policy and recovery behavior.
