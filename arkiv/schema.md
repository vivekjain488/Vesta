# Arkiv schema

Schemas are defined in [src/schemas.ts](src/schemas.ts) and [src/registry-schemas.ts](src/registry-schemas.ts) with `defineSchema(name, columns)`. A named schema tags every entity with an indexed `arkiv.schema` attribute. Only indexed columns can be filtered on.

## Ethereum chain and RPC registry (Mirror track)

**Network:** current Rabdi testnet, chain ID `7794095`. **Creator and initial owner:** `0x0f531Abb28A54435a5848AA70deF32040E2A2e65`, dedicated registry importer. Every curated read filters by the creator. The creator remains fixed after ownership transfer, while the current owner controls updates and deletion. These are public entities: no application login, writer key or team-issued API token is required for direct Arkiv reads.

| Schema | Indexed fields (type) | Payload and links | Expiry |
| --- | --- | --- | --- |
| `ethereum-registry.chain.v1` | uid (str), snapshot_id (str), chain_id (u64), name (str), search_name (str), short_name (str), network_type (str), status (str), parent (str), native_symbol (str), rpc_count (u64), public_https_count (u64), content_hash (str) | Full source chain JSON, full name, inferred network-type basis, source repository and filename. `uid=eip155:<chainId>`; links to RPC rows by chain_id + snapshot_id. | 30 days |
| `ethereum-registry.rpc.v1` | uid (str), snapshot_id (str), chain_id (u64), endpoint_hash (str), host (str), transport (str), requires_key (bool), execution_eligible (bool), source_order (u64), content_hash (str) | Full endpoint URL/template, eligibility reason, source path. UID is chain CAIP ID plus SHA-256 of the exact URL. URL case/path/query are preserved. | 30 days |
| `ethereum-registry.snapshot.v1` | uid (str), snapshot_id (str), status (str), source_commit (str), source_hash (str), chain_count (u64), rpc_count (u64), published_at_ms (u64) | Complete-source counts, duplicate count, pinned Git revision, canonical source digest, full MIT license. Only complete manifests are published. | 30 days |
| `ethereum-registry.head.v1` | uid (str), snapshot_id (str), checked_at_ms (u64), source_commit (str) | `uid=current`; pointer to a complete manifest/generation. Changed only after both table counts agree with the source and writes have confirmed receipts. | 30 days; extended on successful daily checks |

Natural uniqueness is `(writer, schema, snapshot_id, uid)`, enforced by the importer, not a database UNIQUE constraint. All rows retain complete long values in payloads; searchable strings use valid UTF-8 prefixes of at most 128 bytes. `content_hash` is SHA-256 over canonical JSON payload bytes. Snapshot IDs bind source revision, source hash, schema version and weekly retention generation. Network type is an explicit heuristic with an `unknown` category; source `status=active` does not mean the endpoint was probed.

The importer creates a new complete generation on source change and at least weekly for retention. An unsuccessful import never changes the active head. Old generations remain queryable until expiry, including records removed upstream. A head older than 48 hours cannot be used for runtime RPC discovery. The resolver checks the manifest and payload/index integrity, then verifies a chosen endpoint's `eth_chainId`. Data rows are immutable by importer convention, not protected against the owner's normal Arkiv patch/delete authority.

Direct SDK query, without our API or wallet login:

```ts
import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { http } from 'viem';
import { and, eq } from '@arkiv-network/sdk/query';
import { u64 } from '@arkiv-network/sdk/schema';
import { RegistryHead, RegistryRpc } from './src/registry-schemas';

const client = createPublicClient({ chain: rabdi({ accessKey: '' }), transport: http() });
const writer = '0x0f531Abb28A54435a5848AA70deF32040E2A2e65' as const;
const head = await client.select().from(RegistryHead)
  .where(eq('uid', 'current')).createdBy(writer).limit(1).fetch();
const snapshot = head.entities[0].snapshot_id.value;
const result = await client.select().from(RegistryRpc).where(and(
  eq('snapshot_id', snapshot), eq('chain_id', u64(16602n)),
  eq('transport', 'https'), eq('requires_key', false), eq('execution_eligible', true),
)).createdBy(writer).limit(100).fetch();
// result.entities[].payload contains the full endpoint and its source provenance.
```

Anonymous RPC has a quota; readers may use their own optional Arkiv access key. `pnpm registry:query chain 16602` is the runnable equivalent, with payload decoding and manifest verification.

## Existing Atlas and agent schemas

**Owners.**
- **Signature Atlas:** a single importer wallet (`ATLAS_IMPORTER_ADDRESS`). Every read filters `ownedBy(importer)`.
- **Perpetua data:** each agent writes from its own wallet, so `ownedBy(agent)` proves who wrote a record.

**Time.** Existing Atlas/agent schemas use indexed timestamps described below; registry check/publication timestamps use explicitly named millisecond fields above.

**Expiry policy.** 180 days is Arkiv's maximum. The Atlas re-extends that on every daily import. Agent heartbeats extend 30 days on each heartbeat. A retired agent's death certificate is kept for 180 days.

## Signature Atlas (Arkiv Mirror track)

| schema | indexed | stored only (`payload`) | expires |
|---|---|---|---|
| `signature-atlas.entry.v1` | uid, selector, kind (function/event/error), text_signature (≤128 B), source, sources_agreeing, decode_verified, confidence (high/candidate/low/disputed), confidence_votes, chain_first_seen?, submitter, content_hash, import_run, created_at | raw source row, notes, full text if >128 B | 180 d, extended daily |
| `signature-atlas.submission.v1` | uid, selector, submitter, claimed_signature, submitted_at | evidence (tx hash / repo link) | 180 d |
| `signature-atlas.import-run.v1` | run_id, source, source_commit (ETag/count fingerprint), started_at, finished_at? | counts, errors, cursor, diff summary | 180 d |

**`uid` deviates on purpose.** The spec's `selector:kind` would collapse every signature that shares a selector into a single row, which defeats the point of a confidence-ranked Atlas. The uid is `selector:kind:h8`, where `h8` is 4 bytes of `keccak256("atlas-uid:" + text)`.

The `atlas-uid:` prefix matters. Without it, the 4 hash bytes of a function signature are the selector itself, and collisions would come straight back. The friction log has the details.

## Perpetua's own data

| schema | indexed | stored only | links | written | expires |
|---|---|---|---|---|---|
| `perpetua.agent.v1` | agent, name, strategy, status, tier, risk_tier, runway_h, cushion, floor, exposure, followers, win_rate, brier, last_heartbeat, created_at | vault, riskGate, wallet, chain, ledger, caps | — | tier change + hourly | 30 d (death cert 180 d) |
| `perpetua.signal.v1` | uid, agent, asset, chain_id, created_at, commit_hash, status, direction\*, confidence\*, regime\*, outcome\*, r_multiple\*, revealed_at\* | entry, stop, target, 0G chat ID, Flash order ID, reasoning, salt (revealed only) | agent | commit → reveal (15 min) → close | 180 d |
| `perpetua.trade.v1` | uid, agent, asset, side, status, flash_order_id, opened_at, created_at, pnl_usd? | size, entry, stop, target, approval tx, digests | signal, mandate (`key`) | open + close | 180 d |
| `perpetua.risk-check.v1` | uid, checker, requester, asset, chain_id, verdict, reason_code, request_hash, checked_at, created_at | notional, cushion, feed staleness, on-chain replay, payment | Atlas | after replying to the payer | 30 d |
| `perpetua.mandate.v1` | agent, mandate_id, created_at, expires_at | F, C, E, V, risky value, poke tx | — | each RiskGate cycle | 30 d |
| `perpetua.ledger.v1` | agent, engine, hour, amount_usd, created_at | tx hashes, event count | — | one row per engine per hour | 180 d |
| `perpetua.decision-log.v1` | uid, agent, decision, model, tier, input_hash, output_hash, chat_id, tee_verified, credit_cost_og, created_at | approval tx, Flash order, TEE signer, tokens | — | every model call / rejection | 180 d |
| `perpetua.leaderboard-snapshot.v1` | agent, cycle, risk_tier, rank, score, sortino, accuracy, risk_penalty, transparency, track_days, unverified, created_at | full score breakdown | — | every poke() cycle | 180 d |

\* Set at reveal or close, never at commit. These are declared `.optional()`.

**Commit-reveal.** `commit_hash = keccak256(JSON(hidden fields + salt))`. At reveal the payload publishes the hidden fields and the salt, so anyone can recompute the hash.

## Shared market mirror

| Schema | Indexed fields | Payload | Retention |
|---|---|---|---|
| `perpetua.market-observation.v1` | UID, latest/snapshot type, venue, market type, symbol, sampling bucket, source/observation/publication timestamps, bid/ask, mark/index, funding, open interest, content hash | JSON snapshot including top 20 book levels, per-component exchange timestamps and provenance | latest: 1 day renewed; sampled history: 7 days by default |
| `perpetua.market-candles.v1` | UID, venue, symbol, interval, observed timestamp, last closed timestamp, content hash | gzip-compressed JSON with 400 closed 4h OHLCV bars | 1 day renewed |

Market reads filter `ownedBy(ARKIV_MARKET_WRITER_ADDRESS)`. A latest quote is stale if any source component exceeds the allowed age. Hashes cover the decoded JSON. `latest` and candle-window UIDs are stable; historical UIDs include the sampling bucket. See [the running service](../docs/market-mirror.md) for cadence, recovery and query commands.
