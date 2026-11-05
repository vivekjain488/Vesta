# Arkiv schema

All schemas are defined in code in [src/schemas.ts](src/schemas.ts) with `defineSchema(name, columns)`. A named schema tags every entity with an indexed `arkiv.schema` attribute. Only indexed columns can be filtered on.

**Owners.**
- **Signature Atlas:** a single importer wallet (`ATLAS_IMPORTER_ADDRESS`). Every read filters `ownedBy(importer)`.
- **Perpetua data:** each agent writes from its own wallet, so `ownedBy(agent)` proves who wrote a record.

**Time.** Arkiv cannot sort by `$createdAt`, so every entity carries an indexed `created_at` (u64, unix seconds).

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
