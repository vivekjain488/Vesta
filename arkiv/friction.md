# Arkiv friction log

Each snag is logged as we hit it: what we expected, what happened, and a repro.

## Chain/RPC registry feedback (6 November 2026, SDK 1.0.1, Rabdi)

1. **A receipt-only write API makes crash recovery harder than broadcast tracking.** Expected: receive/persist a signed transaction hash before waiting for final receipt, then resume by that hash. Observed: `executeBatch` awaits the receipt and returns its hash afterward. A process interruption between broadcast and return loses that result. Reproduce: call `executeBatch`, interrupt the client after its transport's `eth_sendRawTransaction` but before receipt polling completes, then re-run an importer that only checkpoints returned results. We solved this with a traced transport that persists raw signed transactions, hashes, explicit nonces and row IDs **before broadcast**. Suggestion: expose a prepared/broadcast transaction handle or callback and a documented reconciliation helper. See [import-registry.ts](src/import-registry.ts).
2. **Bulk import needs request-size guidance that includes ABI/hex overhead.** Expected: a payload-size limit to predict safe batching. In this project the market writer encountered HTTP 413 on larger batches even when individual payloads fit SDK limits. The registry avoids that failure by estimating indexed-attribute framing and hexadecimal expansion, capping its batches and writing through bounded nonce concurrency. Reproduce the original issue with a large `executeBatch` request containing several JSON/candle payloads; it can fail at HTTP request/estimate transport before any receipt exists. Suggestion: publish endpoint body caps and provide a batch byte-size estimator/splitter. Raw JSON byte length alone is misleading. The current registry import has not silently dropped records to fit these limits.
3. **Natural-key uniqueness and complete generations are application work.** Expected: a way to define `(creator, snapshot_id, uid)` uniqueness or a documented upsert primitive. Observed: schema/index definitions do not enforce a unique application key; retries can create duplicates. Reproduce: call `createEntity` twice with the same indexed UID under the same schema/owner. We use a dedicated writer, creator-filtered key recovery, exact receipt reconciliation, complete-generation manifests and count checks before publishing a head. Suggestion: a documented natural-key/upsert convention and SDK example for publishing a multi-table snapshot would reduce risk for mirror builders.
4. **The SDK's string limit requires preserving complete URLs elsewhere.** Expected: ordinary registry names/URLs to fit string attributes. Indexed strings are limited to 128 UTF-8 bytes; RPC templates can exceed this. Reproduce: build a `str` value from a URL over 128 bytes and create it. We retain the full URL in bytes payload, index its SHA-256/host/protocol/access classification, and truncate only searchable labels on code-point boundaries. Suggestion: document this registry-style pattern and expose searchable URL components/long-string guidance in examples.
5. **Discovery has a bootstrap boundary.** A database that stores RPC endpoints still needs an RPC to query itself. We keep the canonical Rabdi SDK endpoint as the trust anchor and resolve other remote chains from the mirror. It would help to document recommended bootstrap/failover patterns and how public readers obtain independent access rather than inheriting an application's private RPC key.

These are concrete SDK/API/product observations, not a claim the upstream registry's stale URLs or Anvil/GoChain ID collision are Arkiv bugs. The latter are documented in [data-quality.md](data-quality.md). Public reproduction queries and schemas are in [schema.md](schema.md); the live importer verifies 2,855 chains and 4,219 normalized endpoints before moving its head.

## Earlier Signature Atlas integration notes

1. **Testnet name.**
   - *Expected:* one testnet name across docs and examples.
   - *Happened:* the SDK (v1.0.1) ships `rabdi` (chain id 7794095, gas token tGLM), but the Sourcify example says "Sorbet".
   - *Repro:* `import { rabdi } from "@arkiv-network/sdk/chains"`; there is no `sorbet` export.
   - *Resolution:* we target Rabdi.
2. **Reads and the access key.**
   - *Expected:* public reads need no key.
   - *Happened:* they don't, but the public endpoint is heavily rate limited, and `rabdi({ accessKey: "" })` prints a warning. `rabdi()` with no argument throws `MissingAccessKeyError`.
   - *Fix:* pass `ARKIV_ACCESS_KEY`. The key is not a secret (it ships in the frontend), so it's restricted by origin.
3. **Upsert by natural key.**
   - *Expected:* an `upsert(uid)` call.
   - *Happened:* there is none.
   - *Fix:* query `where(eq("uid", …)).ownedBy(importer)` to find the entity key, then create, `patchEntity` or `extendEntity`. We keep a `uid → entityKey` map ([src/writer.ts](src/writer.ts)) so retries patch instead of duplicating. On a fresh CI runner it's re-seeded from Arkiv with `or(eq…)` chunks of 20.
4. **128-byte string limit.**
   - *Happened:* some 4byte signatures exceed it (long tuple types).
   - *Fix:* `str128()` truncates the indexed `text_signature`, and the full text lives in the `payload` bytes column.
5. **100-row pages.** `MAX_LIMIT = 100`. Bulk export pages by key (`orderBy(asc("$key"))` + `gt("$key", lastKey)`), which stays stable while new rows land. See `pageAll()` in [src/queries.ts](src/queries.ts).
6. **Schema names: 32-byte limit and reserved words.**
   - `perpetua.leaderboard-snapshot.v1` is exactly 32 bytes.
   - Attribute names can't be `order`, `key`, `by`, `desc`, … (we nearly named a column `order`).
7. **No SQL-style SUM/GROUP BY for our rollups.** Win rates, Brier scores and ledger totals are computed client-side from rows (`ledgerTotals()`, `buildHistories()`). The current SDK does support `count().from(...).fetch()`, which the registry uses to verify complete table counts.
8. **No sort by `$createdAt`.** An indexed `created_at` u64 goes on every entity.
9. **Our own bug: uid collision.**
   - `keccak256(text)[0:4]` *is* the selector, so a uid built from a short hash of the text collided for every selector clash.
   - *Repro:* 291 rows fetched, but only 247 distinct entities in the dry-run outbox.
   - *Fix:* domain-separate the hash (`keccak256("atlas-uid:" + text)`).
10. **OpenChain bulk export is gone.** `GET https://api.openchain.xyz/signature-database/v1/export` returns 404 (checked 2026-11-05). We use OpenChain only as a per-selector cross-check (`/v1/lookup`). Bulk rows come from 4byte.directory, which also satisfies the "data must not come from Sourcify" rule.
11. **4byte pagination.** Use `ordering=id&page=N`; the `next` URLs come back as `http://`. The cursor (page per kind) persists in `.perpetua/atlas-cursor.json` and in the CI cache.
12. **`executeBatch` typing.** Heterogeneous creates and patches across schemas need const tuple generics, so the dynamic writer casts to `any`. Runtime validation still runs per schema.
13. **Write latency.** Each write waits for a block (about 2 s). All writes go through a 30–60 s batching worker and never sit on a request path.
