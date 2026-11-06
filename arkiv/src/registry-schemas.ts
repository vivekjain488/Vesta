import { bool, bytes, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";

export const RegistryChain = defineSchema("ethereum-registry.chain.v1", {
  uid: str().indexed(), snapshot_id: str().indexed(), chain_id: u64().indexed(),
  name: str().indexed(), search_name: str().indexed(), short_name: str().indexed(),
  network_type: str().indexed(), status: str().indexed(), parent: str().indexed(),
  native_symbol: str().indexed(), rpc_count: u64().indexed(), public_https_count: u64().indexed(),
  content_hash: str().indexed(), payload: bytes(),
});

export const RegistryRpc = defineSchema("ethereum-registry.rpc.v1", {
  uid: str().indexed(), snapshot_id: str().indexed(), chain_id: u64().indexed(),
  endpoint_hash: str().indexed(), host: str().indexed(), transport: str().indexed(),
  requires_key: bool().indexed(), execution_eligible: bool().indexed(),
  source_order: u64().indexed(), content_hash: str().indexed(), payload: bytes(),
});

/** An immutable completed import plus its pinned upstream commit, license and full-corpus digest. */
export const RegistrySnapshot = defineSchema("ethereum-registry.snapshot.v1", {
  uid: str().indexed(), snapshot_id: str().indexed(), status: str().indexed(),
  source_commit: str().indexed(), source_hash: str().indexed(),
  chain_count: u64().indexed(), rpc_count: u64().indexed(),
  published_at_ms: u64().indexed(), payload: bytes(),
});

/** This pointer is changed only after every row in a snapshot has a successful receipt. */
export const RegistryHead = defineSchema("ethereum-registry.head.v1", {
  uid: str().indexed(), snapshot_id: str().indexed(), checked_at_ms: u64().indexed(),
  source_commit: str().indexed(), payload: bytes(),
});
