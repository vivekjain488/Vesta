# Public Ethereum chain and RPC registry on Arkiv

The registry mirrors **every EIP-155 chain file** at a pinned revision of ethereum-lists/chains. The initial source has 2,855 chain records and 4,220 RPC strings; one repeated URL within the same chain is normalized away, producing **4,219 unique chain/endpoint records**. It does not claim to include every blockchain/provider in existence. Original records, including deprecated chains, templates requiring credentials, HTTP/WebSocket endpoints and empty RPC lists, are preserved with classification rather than silently discarded.

Public writer: `0x0f531Abb28A54435a5848AA70deF32040E2A2e65`. Network: Rabdi, chain ID `7794095`. Deployment metadata: [arkiv/registry-deployment.json](../arkiv/registry-deployment.json). Source licensing: [MIT and attribution](../arkiv/THIRD_PARTY_NOTICES.md). This is not Sourcify data.

## Reproduce and query

From the repository root:

```sh
pnpm registry:import --dry-run       # fetch/pin source, validate license/IDs, report counts; no writes
pnpm registry:import                 # complete resumable import; funded writer required
pnpm registry:query status           # completed snapshot, counts, writer, upstream revision
pnpm registry:query list Ethereum    # indexed, case-insensitive name prefix
pnpm registry:query chain 16602      # 0G chain + RPC rows, read from Arkiv
pnpm registry:query rpcs 8453         # Base RPC rows
pnpm registry:query resolve 16602    # Arkiv lookup + fresh eth_chainId verification
```

Reading uses public Arkiv RPC and does not require the writer key, a VESTA account or permission from this team. `ARKIV_ACCESS_KEY` is optional for readers and raises the heavily limited anonymous RPC quota; get your own free key at Arkiv Hub rather than asking us for ours. A third party can query the SDK directly using the schemas and public creator address. Creator identity remains fixed after an ownership transfer; the current owner retains update and deletion rights. The importer requires Git, Node, dependencies, `ARKIV_REGISTRY_PRIVATE_KEY`, the matching `ARKIV_REGISTRY_WRITER_ADDRESS`, and gas on Rabdi. It is a real writer, not a dry-run outbox.

Public API, also without wallet authentication:

```text
GET http://localhost:8787/registry/status
GET http://localhost:8787/registry/chains?chainId=16602
GET http://localhost:8787/registry/chains?name=ethereum&network=mainnet&limit=25
GET http://localhost:8787/registry/chains?parent=eip155-1
GET http://localhost:8787/registry/rpcs/16602?transport=https&requiresKey=false&eligible=true
GET http://localhost:8787/registry/resolve/16602
```

`snapshot` plus `after` form a stable keyset cursor; use the returned `nextAfter` with the same filters. Metadata and chains page by numeric chain ID; RPC rows page by original source order. The API permits cross-origin public GETs and bounds page size, requests per client and concurrent endpoint probes. Direct Arkiv queries remain independent of our API. The local frontend adds **Chain registry** to the signed-in app, preserving the product's MetaMask login gate; public data/API access is separate from account data.

## Publishing and freshness

The importer clones only the public upstream Git data repository, checks out a commit and reads JSON/LICENSE; it executes no upstream build code. Chain filenames must match their positive, safe-integer IDs, IDs must be unique, and malformed records or a suspiciously small corpus abort the run. SHA-256 hashes cover canonical source and row payloads; indexed strings have a 128-byte limit, so full names and full URLs remain in JSON payloads. Source URLs are never populated from our `.env`.

Each source revision is published as a complete generation: chain table, endpoint table, completed snapshot manifest, then an atomic change to the current head. Readers use the head's snapshot filter and original creator identity; staged entities cannot leak into active results. Before changing the head, the importer queries Arkiv counts and requires exact agreement with the full normalized source. Removed endpoints/chains disappear from the new active snapshot; older generations remain explicitly queryable until expiration. Records are immutable by importer convention; the owner still has Arkiv's normal patch/delete authority. Public creator identity and transaction history make attribution inspectable, not upstream metadata intrinsically truthful.

Re-running the same commit/generation recovers existing natural keys and does not create another copy of its data rows. Before broadcast, signed transactions, their hashes, nonces and row IDs are journaled; a restart replays/reconciles the **same signed transaction** rather than buying duplicate entities. A dedicated wallet and PID lock prevent independent writers racing its nonce stream. Batch sizes include ABI/hex overhead; concurrency defaults to twelve, capped at sixteen. Do not run two importers with this writer from different machines. Multi-host operation would require a shared durable lease.

Every entity expires after **30 days**. A new weekly generation is created even when upstream has no changes, refreshing the corpus well before expiration. The local daily scheduler and optional GitHub workflow check upstream daily. The head records the actual successful source check time. The runtime refuses RPC discovery if its head is older than **48 hours**. If publication fails, the previous complete head remains active; the failure is visible in logs and its increasing age. The mirror is not permanent unless someone continues paying for refresh/retention.

State/evidence: `.perpetua/registry-source-report.json`, `.perpetua/registry-import.json`, `.perpetua/registry-live-verification.json`. The checkpoint contains signed public transactions, never private keys. Source reports include the exact upstream hash, license and de-duplication counts. Writer keys stay only in local/CI secret configuration.

## Runtime dependence on Arkiv

`projectRpc` / `projectTransport` are used by agent chain clients, the API's chain reader, direct 0G inference and 0G testnet setup. In normal `RPC_DISCOVERY=arkiv` mode, remote chain endpoints come from Arkiv's current snapshot; there is **no automatic GitHub/chainid.network/hardcoded-URL fallback**. A short one-minute resolver cache avoids a database lookup on every RPC request. `RPC_DISCOVERY=env` is an explicit operator escape hatch for private providers or an outage; it is not counted as Arkiv discovery. Private URLs and API keys are never published to the mirror.

Runtime candidates must be active-chain, public HTTPS, free of credential placeholders/userinfo and eligible public hosts/ports. A fresh `eth_chainId` probe must match the requested chain. The server transport pins validated public DNS to each TLS request and rejects local/private/reserved targets, redirects and oversized responses. RPCs remain external services; a matching chain ID is a point-in-time identity check, not proof that every returned state value is correct or that an upstream node will always be available. HTTP/WebSocket/key-required records remain discoverable metadata but are not selected for unattended execution.

Two deliberate bootstrap exceptions exist:

* **Arkiv itself** needs an initial trusted Rabdi RPC/SDK chain definition to query the registry; resolving the database endpoint through itself would be circular. That URL may carry your private Arkiv access key at runtime and is never mirrored from configuration.
* **Local Anvil `31337`** requires an explicitly configured loopback endpoint. ethereum-lists assigns the same ID to **GoChain Testnet**. Local dev keys must never be sent to that public endpoint. Other local chain identities should also be configured explicitly rather than inferred from a reused chain ID.

0G Compute's inference/router API and provider service URLs are not blockchain JSON-RPC URLs. This mirror resolves the 0G **chain RPC**; it does not turn a Router inference key into native tokens or make an unfunded model callable.
