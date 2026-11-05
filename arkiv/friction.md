# Arkiv friction log

Each snag is logged as we hit it: what we expected, what happened, and a repro.

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
7. **No aggregates.** Win rates, Brier scores and ledger totals are computed client-side from rows (`ledgerTotals()`, `buildHistories()`).
8. **No sort by `$createdAt`.** An indexed `created_at` u64 goes on every entity.
9. **Our own bug: uid collision.**
   - `keccak256(text)[0:4]` *is* the selector, so a uid built from a short hash of the text collided for every selector clash.
   - *Repro:* 291 rows fetched, but only 247 distinct entities in the dry-run outbox.
   - *Fix:* domain-separate the hash (`keccak256("atlas-uid:" + text)`).
10. **OpenChain bulk export is gone.** `GET https://api.openchain.xyz/signature-database/v1/export` returns 404 (checked 2026-11-05). We use OpenChain only as a per-selector cross-check (`/v1/lookup`). Bulk rows come from 4byte.directory, which also satisfies the "data must not come from Sourcify" rule.
11. **4byte pagination.** Use `ordering=id&page=N`; the `next` URLs come back as `http://`. The cursor (page per kind) persists in `.perpetua/atlas-cursor.json` and in the CI cache.
12. **`executeBatch` typing.** Heterogeneous creates and patches across schemas need const tuple generics, so the dynamic writer casts to `any`. Runtime validation still runs per schema.
13. **Write latency.** Each write waits for a block (about 2 s). All writes go through a 30–60 s batching worker and never sit on a request path.
