# Data quality: complete, attributable chain/RPC snapshots

## Coverage and source

The initial pinned commit is [e17474286275730fb6b0490b1d7ea1c64a36ed9e](https://github.com/ethereum-lists/chains/tree/e17474286275730fb6b0490b1d7ea1c64a36ed9e). Every EIP-155 chain file is imported: **2,855 chains; 4,220 original RPC strings; 4,219 distinct chain/URL rows**. One duplicate URL within its chain is de-duplicated and counted. The raw chain JSON remains in each chain payload, including the original RPC list, so normalization is auditable. These are the upstream registry's contents, not a claim to every chain or provider in existence.

Records include the source filename and the snapshot's exact Git commit, canonical SHA-256 source digest and MIT license. The importer validates filenames against numeric chain IDs, positive safe integers, duplicate IDs, required fields and an expected minimum corpus size. A malformed source aborts publication instead of silently skipping chains. Long names/URLs remain complete in payloads; only searchable string fields are bounded to Arkiv's 128-byte limit.

## Freshness and refresh

The local macOS scheduler runs an upstream refresh every 24 hours. [.github/workflows/registry-import.yml](../.github/workflows/registry-import.yml) supplies an optional daily/manual CI job; CI requires its own secrets and must not race the local writer. Re-run `pnpm registry:import` manually. A crashed run resumes its pinned source and signed transactions before taking a newer source revision.

Every data row expires after 30 days. Even with no source changes, a new weekly generation refreshes retention before expiry. The current head records the time upstream was actually checked, which `pnpm registry:query status` and `/registry/status` expose. The runtime refuses a registry older than 48 hours. An importer failure leaves the last complete snapshot active and its age visible. This service runs locally while its host is awake; the repository workflow is not represented as configured cloud hosting.

## Complete snapshots and removals

Chain rows and RPC rows share a snapshot ID. A completed manifest records expected source counts. After every data write has a successful receipt, independent Arkiv count queries must exactly match both tables. Only then is the current head updated. Removed upstream records are absent from the next active generation; old snapshots remain intentionally queryable until expiration. Same-revision reruns re-use natural keys rather than duplicating rows. A dedicated writer, process lock, explicit nonces and a signed-transaction journal make a restart reconcile the original transaction instead of blindly resending a new create.

## Query fields people use

* Chains: numeric `chain_id`, name prefix through `search_name`, `short_name`, `network_type`, source `status`, `parent`, native symbol, total endpoint count and eligible HTTPS count.
* RPCs: numeric chain ID, `transport`, `requires_key`, `execution_eligible`, hostname, endpoint hash and source order.
* Both: snapshot ID, creator identity, canonical payload hash and full payload/source provenance.

`network_type` is explicitly an inference: test naming/slip44=1, mainnet naming/non-test slip44, otherwise **unknown**. It is not presented as a universally authoritative upstream mainnet flag. Active status means upstream status/default, not a current uptime claim. Source endpoints marked deprecated, requiring a key, malformed, insecure, private or WebSocket-only stay in the mirror; only execution eligibility changes.

## Runtime validation

The resolver selects eligible public HTTPS endpoints from an active chain and checks `eth_chainId` live. Wrong-chain responses, stale snapshots, RPC errors, credential placeholders, userinfo, local/private DNS targets, redirects and oversized responses are rejected. It tries up to five candidates. It does not mark every mirrored RPC healthy: unprobed entries remain unverified metadata. The server transport pins validated DNS to its TLS request. A chain-ID check is not a cryptographic proof of correct RPC state.

Anvil's chain ID 31337 collides with the registry's GoChain Testnet. Local clients therefore require explicit loopback configuration and never perform public registry discovery for that development identity. Arkiv's own SDK endpoint is a documented bootstrap dependency, avoiding circular discovery.

## Evidence and runnable checks

```sh
pnpm registry:import --dry-run
pnpm registry:query status
pnpm registry:query chain 16602
pnpm registry:query resolve 16602
pnpm --filter @perpetua/core test
```

The importer writes `.perpetua/registry-live-verification.json` only after successful publication. It contains exact confirmed counts, gas/transaction evidence and sample entity keys. The reader verifies each payload's canonical hash and indexed identity before returning it. Tests cover normalization, duplicates, Unicode/long URLs, private addresses, key templates, pagination constraints, wrong-chain failover, stale data, local-chain collision and RPC selection/provenance. The mirror does not verify that every registered chain still exists or every endpoint has honest state; it preserves source status and makes validation scope explicit.
