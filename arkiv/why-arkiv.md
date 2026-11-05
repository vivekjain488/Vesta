# Why Arkiv

1. **Confidence-ranked answers from several sources at once.** Each entry carries `sources_agreeing`, `decode_verified` and a `confidence` grade. A query such as `where(eq("selector", s))` returns every candidate with its evidence, which no single upstream API gives you. The docs alone can't either.
2. **Tamper-evident submitter history.** Every row is owned by the wallet that wrote it, so `ownedBy(importer)` tells curated rows apart from community submissions (`signature-atlas.submission.v1`). Each import run records its source fingerprint.
3. **Data no single maintainer can take down.** Etherface and the OpenChain export both vanished when their maintainers moved on. On Arkiv the mirror outlives this team: any wallet can keep re-importing, and reads are public, free and permissionless.
4. **The same properties carry Perpetua's own trust story.** A stranger hiring an agent needs the full track record from a source the agent's owner doesn't control:
   - commit-reveal signals, so confidence can't be edited after the outcome;
   - an hourly income ledger, showing fees paid compute before profit;
   - TEE-backed decision logs;
   - every leaderboard snapshot.

   There is no backend database to trust. The Arena reads Arkiv straight from the browser.
