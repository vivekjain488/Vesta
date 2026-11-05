# Data quality

**Daily import.** [.github/workflows/atlas-import.yml](../.github/workflows/atlas-import.yml) runs every day, resuming the 4byte page cursor. Run it by hand with `pnpm atlas:import`.

**Per-run provenance.** Every run writes a `signature-atlas.import-run.v1` entity:
- `source_commit`: the ETag or count fingerprint of each 4byte endpoint;
- `payload`: counts (fetched, rejected for hash mismatch, created, patched, extended, hot-set size, decode verified/failed), errors, the cursor, and a diff summary.

**Integrity checks on every row.**
1. The selector is recomputed from the text (`keccak256(text)[0:4]`, or the full hash for events). A mismatch is rejected outright and counted.
2. Each candidate is cross-checked against OpenChain, an independent source, and the number of agreeing sources is stored.
3. **On-chain decode verification.** Live calldata is sampled from the latest Base, Arbitrum and Ethereum blocks. Every candidate for a seen selector is ABI-decoded against real inputs. A candidate that fails is flagged `low`, never deleted, because several valid signatures can share one selector.

**Confidence grades.**

| grade | rule |
|---|---|
| `high` | ≥2 agreeing sources plus ≥1 successful real-calldata decode, no decode failures and no known collisions |
| `candidate` | single source, no conflict |
| `disputed` | several signatures share the selector, even if one decodes successfully |
| `low` | decoding real calldata failed and nothing decoded successfully |

Every signature remains a candidate. A `high` record is labeled corroborated, never fact: ABI decoding and upstream agreement do not establish a deployed contract's semantics. Re-import existing rows to update earlier confidence grades.

**Last dry run (2026-11-05):**
- 295 rows (1 page per kind + 91-row live hot set);
- 0 hash mismatches;
- 85 real-calldata decode successes, 38 failures (flagged `low`);
- `transfer(address,uint256)`: `high`, 2 sources, 3 decodes.

**Runnable queries** ([src/queries.ts](src/queries.ts)):
```bash
pnpm --filter @perpetua/arkiv query lookup 0xa9059cbb    # resolve a selector (importer-owned rows only)
pnpm --filter @perpetua/arkiv query low-confidence       # low / disputed selectors
pnpm --filter @perpetua/arkiv query stale 7              # stale-feeds query: rows no import has refreshed in 7 days
pnpm --filter @perpetua/arkiv query runs                 # import-run history
```
