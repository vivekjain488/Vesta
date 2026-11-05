/**
 * Query cookbook. Arkiv has no aggregates, so totals/win-rates are computed here from rows; exports longer
 * than 100 rows page by key (asc('$key') + gt('$key', lastKey)), which does not shift as new rows land.
 *
 *   tsx src/queries.ts lookup 0xa9059cbb
 *   tsx src/queries.ts low-confidence
 *   tsx src/queries.ts stale           # entries the latest import runs no longer refresh
 *   tsx src/queries.ts runs
 */
import "dotenv/config";
import { and, asc, eq, gt, lt, or } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import type { Address, Hex } from "viem";
import { arkivPublic } from "./client";
import { AgentEntity, AtlasEntry, AtlasImportRun, LedgerEntity, SignalEntity, TradeEntity } from "./schemas";

const IMPORTER = (process.env.ATLAS_IMPORTER_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;

/** Resolve a selector through the Atlas. Discovery, not blind trust: only importer-owned rows. */
export async function lookupSelector(selector: string, importer: Address = IMPORTER) {
  const res = await (arkivPublic() as any)
    .select({ $key: true, text_signature: true, kind: true, confidence: true, sources_agreeing: true, decode_verified: true, source: true })
    .from(AtlasEntry)
    .where(eq("selector", selector.toLowerCase()))
    .ownedBy(importer)
    .limit(100)
    .fetch();
  return res.entities.map((r: any) => ({
    key: r.$key as Hex,
    signature: r.text_signature.value as string,
    kind: r.kind.value as string,
    confidence: r.confidence.value as string,
    sourcesAgreeing: Number(r.sources_agreeing.value),
    decodeVerified: Number(r.decode_verified.value),
    /** ABI decoding/source agreement is corroboration, never proof of a deployed contract's semantics. */
    corroborated: r.confidence.value === "high",
    asFact: false,
  }));
}

export async function lowConfidence(importer: Address = IMPORTER) {
  const res = await (arkivPublic() as any)
    .select({ selector: true, text_signature: true, confidence: true })
    .from(AtlasEntry)
    .where(or(eq("confidence", "low"), eq("confidence", "disputed")))
    .ownedBy(importer)
    .limit(100)
    .fetch();
  return res.entities.map((r: any) => ({ selector: r.selector.value, signature: r.text_signature.value, confidence: r.confidence.value }));
}

/** "Stale feeds": entries not touched by an import in the last `days` days. */
export async function staleEntries(days = 7, importer: Address = IMPORTER) {
  const cutoff = BigInt(Math.floor(Date.now() / 1000) - days * 86400);
  const res = await (arkivPublic() as any)
    .select({ selector: true, text_signature: true, import_run: true, created_at: true })
    .from(AtlasEntry)
    .where(lt("created_at", u64(cutoff)))
    .ownedBy(importer)
    .limit(100)
    .fetch();
  return res.entities.map((r: any) => ({ selector: r.selector.value, signature: r.text_signature.value, lastRun: r.import_run.value }));
}

export async function importRuns(importer: Address = IMPORTER) {
  const res = await (arkivPublic() as any).select().from(AtlasImportRun).ownedBy(importer).limit(100).fetch();
  return res.entities.map((r: any) => ({ runId: r.run_id.value, source: r.source.value, commit: r.source_commit.value, startedAt: Number(r.started_at.value) }));
}

/** Page any schema by key: stable under concurrent writes. */
export async function* pageAll(schema: any, owner?: Address) {
  let lastKey: Hex | undefined;
  for (;;) {
    let q = (arkivPublic() as any).select().from(schema);
    if (lastKey) q = q.where(gt("$key", lastKey));
    if (owner) q = q.ownedBy(owner);
    const res = await q.orderBy(asc("$key")).limit(100).fetch();
    if (res.entities.length === 0) return;
    yield res.entities;
    lastKey = res.entities[res.entities.length - 1].$key;
    if (res.entities.length < 100) return;
  }
}

// --------------------------------------------------------------- Perpetua reads (Arena, hirers, judges)

export async function agents() {
  const res = await (arkivPublic() as any).select().from(AgentEntity).limit(100).fetch();
  return res.entities;
}

export async function signalsFor(agent: Address) {
  const res = await (arkivPublic() as any).select().from(SignalEntity).where(eq("agent", agent)).ownedBy(agent).limit(100).fetch();
  return res.entities;
}

export async function tradesFor(agent: Address) {
  const res = await (arkivPublic() as any).select().from(TradeEntity).where(eq("agent", agent)).ownedBy(agent).limit(100).fetch();
  return res.entities;
}

/** Did fees actually pay for compute before becoming owner profit? Sum engine rows per hour window. */
export async function ledgerTotals(agent: Address, sinceHour = 0) {
  const totals: Record<string, number> = {};
  const res = await (arkivPublic() as any)
    .select({ engine: true, amount_usd: true })
    .from(LedgerEntity)
    .where(and(eq("agent", agent), gt("hour", u64(BigInt(sinceHour)))))
    .ownedBy(agent)
    .limit(100)
    .fetch();
  for (const r of res.entities) totals[r.engine.value] = (totals[r.engine.value] ?? 0) + Number(r.amount_usd.value);
  return totals;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const run = async () => {
    if (cmd === "lookup") return lookupSelector(arg ?? "0xa9059cbb");
    if (cmd === "low-confidence") return lowConfidence();
    if (cmd === "stale") return staleEntries(Number(arg ?? 7));
    if (cmd === "runs") return importRuns();
    if (cmd === "agents") return agents();
    throw new Error("usage: queries.ts lookup <selector> | low-confidence | stale [days] | runs | agents");
  };
  run()
    .then((r) => console.log(JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)))
    .catch((e) => (console.error(e), process.exit(1)));
}
