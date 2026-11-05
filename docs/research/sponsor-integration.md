# Sponsor integration research

Checked against the [ETHGlobal Mumbai prize page](https://ethglobal.com/events/mumbai/prizes) on 6 November 2026. The page has the exact event and prize requirements. The repository currently describes live integrations as pending and its scripted demo as simulated; the items below distinguish implementation paths from evidence of live execution.

## Priorities

1. **Establish a real earnings-to-compute path.** Show an independent customer paying an agent for a useful service, the proceeds funding that same agent's 0G account, and a subsequent inference paid from that account. Capture transaction receipts, request IDs and account balances; label seed funds, simulations and test tokens separately.
2. **Prove the actual CCIP lane and asset.** The proposed native 0G cross-chain token and swap are assumptions, not verified deployments. [Chainlink's testnet directory](https://docs.chain.link/ccip/supported-networks/testnet) lists 0G Galileo with five lanes and one token; its [CCIP-BnM token page](https://docs.chain.link/ccip/directory/testnet/token/CCIP-BnM) lists the test token on 0G. This does not establish a native 0G CCT or conversion into spendable native 0G. Check the exact source/destination lane, router, token pool, swap liquidity and unwrap path before designing the demo around them.
3. **Make one Arkiv mirror demonstrably usable.** Publish permitted source data with a rerunnable importer, run it against the current Arkiv testnet, and show a judge querying the writer-owned entities through the Atlas and risk-check flow. Preserve provenance and collision ambiguity; an ABI decoding successfully is evidence of compatibility, not proof of a transaction's intended function.

## Chainlink: CCIP 2.0

The [Mumbai CCIP prize](https://ethglobal.com/events/mumbai/prizes) requires using CCIP inside smart contracts to make a blockchain state change. It suggests cross-chain DeFi and yield aggregation; a local simulator helps development, but the page does not say a live testnet deployment is mandatory for this prize. A real CCIP transfer is stronger evidence than the local mock.

The intended path is economically meaningful: vault earnings → source-chain swap → CCIP token and agent/epoch payload → destination treasury credit → agent compute funding. `contracts/src/HarvestRouter.sol` builds this programmable transfer and `contracts/src/ComputeTreasury.sol` checks an allowlisted chain/sender, message ID and epoch before crediting the received token. Chainlink's [programmable transfer guide](https://docs.chain.link/ccip/evm/tutorials/application-developers/programmable-token-transfers) and [receiver reference](https://docs.chain.link/ccip/evm/api-reference/v2.0.0/ccip-receiver) describe source/sender validation and application-level replay handling.

**Open integration risks and improvements**

- Confirm the current chain IDs and supported lane in the directory; [Chainlink announced a Galileo testnet replacement](https://docs.chain.link/changelog/ccip-expands-to-0g-galileo-testnet). Record exact network names, selectors, router and pool addresses. A chain being supported does not prove a particular token or route is supported.
- Identify the actual destination asset and an executable, sufficiently liquid conversion to native 0G, including gas and slippage. CCIP-BnM demonstrates the cross-chain machinery but cannot itself pay real 0G inference. If no suitable asset/route exists, use a supported lane for a clearly labeled CCIP demonstration and independently implement a documented earnings-to-0G funding mechanism; do not claim they form a single live money loop.
- Current receiver deduplicates `agentId` + `epoch` globally, even though it allows multiple source chains. Include source chain or a globally unique harvest ID in the business identifier if multiple vaults/chains can harvest in one epoch. Reject unexpected token counts, missing tokens and zero/short deliveries deliberately, and specify recovery for failed execution. Reconcile partial delivery and excess tokens instead of silently stranding a difference.
- Constrain the swap with a trustworthy independent minimum output and deadline; a minimum derived only from the same adapter's quote does not protect against a manipulated quote. Account for actual CCIP and source/destination gas expenses in the agent economics.

**Proof checklist**

- [ ] Deployed source and receiver addresses, source/destination chain IDs and selectors, source sender allowlist, token and pool addresses, and configuration.
- [ ] Source earnings and harvest transaction; swap input/output and fee; CCIP message ID and [CCIP Explorer](https://ccip.chain.link/) link; destination transaction, credited agent and amount.
- [ ] Evidence the destination asset actually becomes the native asset used by the compute ledger, or an explicit statement that this is a separate test-token demo.
- [ ] Demonstrate rejected untrusted sender, duplicate delivery and failed/short delivery recovery, as applicable.

## 0G: Agents That Pay for Themselves

The [Mumbai 0G prize](https://ethglobal.com/events/mumbai/prizes) requires the full money-in → agent compute credit → inference loop with transaction hashes and request IDs, unattended operation during the demo, a spend cap and graceful low-funds behavior. A paid service or another agent paying counts; self-trading a token to create artificial revenue or a human refilling the wallet does not. The optional comfy path has additional agent ID, token address and fees-tab evidence.

`agent/src/zerog.ts` already sketches direct wallet-owned ledgers, provider subaccounts and token budgets; `agent/src/agent.ts` defines runway tiers and a treasury-to-ledger feed. `scripts/forward-income.ts` forwards recorded x402 income. The [0G direct inference docs](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference) distinguish the main ledger from provider subaccounts. A decrease in the main ledger alone is not a per-inference cost receipt: it can reflect a transfer to a subaccount. Check actual SDK return values and settlement/account data before claiming that a particular request was paid from earnings.

**Open integration risks and improvements**

- Make each agent's owner, earning wallet, 0G ledger, treasury entitlement, cap and strategy configurable and independently identifiable. Treat setup seed, gas subsidy and earned revenue as different sources. Persist payment/forwarding IDs across restarts, and only credit successfully settled, non-duplicated payments.
- Capture real ledger deposit and provider funding transaction hashes and receipts. At the time of this review `depositOg()` returned a descriptive string rather than a transaction hash. Record request ID, provider, model, validated usage and a reliable paid/settled amount or explicitly mark the amount unknown; do not infer a zero cost from missing data.
- Preserve daily spend limits across restarts and account for provider subaccount balances and any automatic funding. Make low balance, failed provider and exhausted caps pause or reduce the agent's inference safely, and demonstrate recovery after earned income reaches the account. Avoid automatic unfunded withdrawal attempts above the remaining daily cap.
- Show a real customer buying the useful risk-check or signal service. x402 dev-mode calls, mock swap liquidity, test income, initial ledger seed and the local demo are not evidence of third-party revenue.

**Proof checklist**

- [ ] Agent ID and its owning/configuring wallet, earning wallet, 0G ledger and provider; clear disclosure of startup funds and gas.
- [ ] Independent buyer's settled payment transaction, service request and receipt; proceeds forwarding/harvest/conversion transactions, then the same agent's ledger deposit receipt.
- [ ] Main ledger and provider subaccount balances with timestamps, provider funding/settlement evidence, inference request ID, model and verified response. Show a subsequent paid call after the earned deposit.
- [ ] On-screen configured cap and exhausted/low-balance behavior; agent runs without a manual top-up. Display any unverified costs as unknown.

## Arkiv: Mirror something Ethereum depends on

The [Mumbai Arkiv mirror prize](https://ethglobal.com/events/mumbai/prizes) calls for public Ethereum data other than Sourcify data, a license allowing republication, a rerunnable importer, writes to the current Arkiv testnet and a feature or query that reads those entities. It also requires a public open-source repository, AI-use disclosure, importer wallet and runnable query in the README, and `/arkiv/schema.md`, `/arkiv/friction.md`, `/arkiv/reach.md`, `/arkiv/why-arkiv.md` and `/arkiv/data-quality.md`. This track is for projects built from scratch during the event; existing-project eligibility is a separate Continuity prize. The page gives Rabdi chain ID 7794095 and endpoints; recheck the current docs before deployment.

The existing Signature Atlas importer mirrors 4byte function/event selectors, cross-checks candidates against OpenChain and samples calldata. `/v1/atlas/:selector`, the Atlas screen and optional calldata lookup in `/v1/risk-check` read the Atlas. Arkiv writes have not yet been demonstrated in the README; without an Arkiv private key the writer uses a local outbox. `arkiv/reach.md` still contains TODOs.

**Open integration risks and improvements**

- Link the exact source's permission for republication in the README. The [4byte API documentation](https://www.4byte.directory/docs/) describes its API as free to use without restriction, but do not present that sentence as a separately verified named data license. Verify that the actual mirrored records and any enrichment can be republished and are not Sourcify-derived. The [ethereum-lists/4bytes repository](https://github.com/ethereum-lists/4bytes) lists an MIT license and is a possible alternative source, subject to verifying the provenance of the chosen records against the track's exclusion.
- Link each indexed record to its source, source version or ID, import run, update time, owner and expiration; publish coverage, rejected records and freshness measurements. A page-based incremental import should also revisit recent records and refresh expiry for previously imported entries; advancing a cursor over only new pages does not refresh old entities.
- Keep all selector collisions visible. At review time, `lookupSelector()` set `asFact` after two source matches or one clean decode; two services may share upstream data, and distinct ABI signatures can both decode the same bytes. This implementation pass changes `asFact` to false, labels stronger evidence as corroboration and keeps known collisions disputed. Re-import existing records to update confidence grades; address-specific ABI evidence is still needed before treating a name as authoritative.
- Avoid claiming immutable records or guaranteed longevity: Arkiv entities have owners and expiry. Document who can update/delete each record, how outsiders query or independently mirror it, and the renewal policy. Evidence should not imply the agent's owner cannot control records written by that owner.

**Proof checklist**

- [ ] Source and license/provenance links, import command and pinned source version, importer address, network, successful write transaction and entity key.
- [ ] A fresh independent read, with selector, owner filter and exact runnable query; show a real Atlas or risk-check response backed by that entity.
- [ ] Import run counts, timestamps, errors, refresh behavior, data-quality checks and a colliding-selector example with uncertainty preserved.
- [ ] Complete the five judging documents, README setup/query/writer details, project license and AI-use disclosure; confirm track eligibility and event timing.

## Simulation boundary

The local Anvil/mock CCIP demo, simulated 0G brain, unpaid x402 development mode and Arkiv outbox are useful for reproducible integration tests. Their synthetic balances, signatures, message IDs and request IDs are not proof of a live transfer, customer revenue, live 0G inference or an Arkiv testnet write. Keep simulated artifacts visibly labeled and attach real receipts separately when those integrations are run.
