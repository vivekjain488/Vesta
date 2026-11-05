/**
 * Signature Atlas import pipeline (re-runnable; also runs daily as a GitHub Action).
 *
 *   1. Fetch 4byte.directory (functions + events) from a resumable page cursor, plus a "hot set": selectors
 *      seen in live calldata on Base/Arbitrum/Ethereum, imported first because that is what Perpetua's
 *      risk-check and decoding services actually need. Record each source's ETag/count.
 *   2. Normalise, recompute every selector from its text (mismatch = rejected), content_hash per record.
 *   3. Cross-check OpenChain per selector (independent second source) and decode-verify against real calldata.
 *   4. Upsert by uid, filtered by the importer wallet: new -> create, changed hash -> patch,
 *      unchanged -> extend expiry only. Sent with executeBatch.
 *   5. Write an import-run entity with counts, errors and the source fingerprint.
 *
 * Env: ARKIV_PRIVATE_KEY (importer wallet; omit for a dry run to .perpetua/), ARKIV_ACCESS_KEY,
 *      ATLAS_MAX_PAGES (default 5 per kind per run), ATLAS_HOT_BLOCKS (default 2).
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { or, eq } from "@arkiv-network/sdk/query";
import { arkivPublic } from "./client";
import { AtlasEntry, AtlasImportRun, EXPIRY_DAYS, jsonBytes, str128, addr, i32, u64 } from "./schemas";
import { fetch4byte, lookup4byte, openchainLookup, selectorOf, type RawSignature } from "./sources";
import { decodesCleanly, sampleCalldata } from "./verify-calldata";
import { ArkivWriter } from "./writer";

const STATE = ".perpetua/atlas-cursor.json";

export type Confidence = "high" | "candidate" | "low" | "disputed";

export interface NormalisedEntry {
  uid: string;
  selector: string;
  kind: RawSignature["kind"];
  text: string;
  source: RawSignature["source"];
  sourcesAgreeing: number;
  decodeVerified: number;
  decodeFailed: number;
  confidence: Confidence;
  contentHash: Hex;
  raw: RawSignature;
}

export function classify(e: { sourcesAgreeing: number; decodeVerified: number; decodeFailed: number; siblings: number }): Confidence {
  if (e.decodeFailed > 0 && e.decodeVerified === 0) return "low";
  if (e.decodeVerified > 0 || e.sourcesAgreeing >= 2) return e.siblings > 1 && e.decodeVerified === 0 ? "disputed" : "high";
  return e.siblings > 1 ? "disputed" : "candidate";
}

export function uidOf(selector: string, kind: string, text: string) {
  // NB: keccak(text)[0:4] IS the selector, so hash a domain-separated string to tell colliding signatures apart.
  return `${selector}:${kind}:${keccak256(toBytes(`atlas-uid:${text}`)).slice(2, 10)}`;
}

async function main() {
  mkdirSync(".perpetua", { recursive: true });
  const cursor = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { function: 1, event: 1 };
  const maxPages = Number(process.env.ATLAS_MAX_PAGES ?? 5);
  const pk = process.env.ARKIV_PRIVATE_KEY as Hex | undefined;
  const importer: Address = pk ? privateKeyToAccount(pk).address : "0x0000000000000000000000000000000000000000";
  const runId = `run-${new Date().toISOString().slice(0, 19)}-${Math.random().toString(16).slice(2, 6)}`;
  const startedAt = Math.floor(Date.now() / 1000);
  const writer = new ArkivWriter("atlas", { maxOpsPerBatch: 60 });
  const counts = { fetched: 0, rejectedHashMismatch: 0, created: 0, patched: 0, extended: 0, hot: 0, decodeVerified: 0, decodeFailed: 0 };
  const errors: string[] = [];
  const fingerprints: Record<string, string> = {};

  // ---- 1. hot set from live calldata, then the bulk cursor
  const samples = await sampleCalldata(Number(process.env.ATLAS_HOT_BLOCKS ?? 2)).catch(() => new Map());
  const raws: RawSignature[] = [];
  for (const sel of [...samples.keys()].slice(0, 60)) {
    try {
      const rows = await lookup4byte(sel, "function");
      raws.push(...rows);
      counts.hot += rows.length;
    } catch (e) {
      errors.push(`hot ${sel}: ${(e as Error).message}`);
    }
  }
  for (const kind of ["function", "event"] as const) {
    try {
      for await (const page of fetch4byte(kind, { startPage: cursor[kind], maxPages })) {
        raws.push(...page.rows);
        fingerprints[`4byte:${kind}`] = page.etag;
        cursor[kind] = page.page + 1;
      }
    } catch (e) {
      errors.push(`4byte ${kind}: ${(e as Error).message}`);
    }
  }
  counts.fetched = raws.length;

  // ---- 2. normalise + recompute selectors
  const valid = raws.filter((r) => {
    const ok = selectorOf(r.text, r.kind) === r.selector;
    if (!ok) counts.rejectedHashMismatch++;
    return ok;
  });
  const bySelector = new Map<string, RawSignature[]>();
  for (const r of valid) bySelector.set(r.selector, [...(bySelector.get(r.selector) ?? []), r]);

  // ---- 3. independent cross-check + decode verification
  const fnSel = [...bySelector.keys()].filter((s) => s.length === 10);
  const evSel = [...bySelector.keys()].filter((s) => s.length === 66);
  const oc = new Map([...(await openchainLookup(fnSel, "function")), ...(await openchainLookup(evSel, "event"))]);

  const entries: NormalisedEntry[] = [];
  for (const [selector, rows] of bySelector) {
    const uniq = [...new Map(rows.map((r) => [r.text, r])).values()];
    for (const r of uniq) {
      const ocList = oc.get(selector) ?? [];
      const sourcesAgreeing = 1 + (ocList.includes(r.text) ? 1 : 0);
      let decodeVerified = 0;
      let decodeFailed = 0;
      if (r.kind === "function") {
        for (const s of samples.get(selector) ?? []) (decodesCleanly(r.text, s.data) ? decodeVerified++ : decodeFailed++);
      }
      counts.decodeVerified += decodeVerified;
      counts.decodeFailed += decodeFailed;
      const confidence = classify({ sourcesAgreeing, decodeVerified, decodeFailed, siblings: uniq.length });
      const contentHash = keccak256(toBytes(`${r.kind}|${selector}|${r.text}|${sourcesAgreeing}|${decodeVerified}`));
      entries.push({ uid: uidOf(selector, r.kind, r.text), selector, kind: r.kind, text: r.text, source: r.source, sourcesAgreeing, decodeVerified, decodeFailed, confidence, contentHash, raw: r });
    }
  }

  // ---- 4. upsert: seed uid -> key (owned by the importer) so reruns patch instead of duplicating
  const existing = new Map<string, { key: Hex; hash: string }>();
  if (pk) {
    const pub = arkivPublic();
    const uids = entries.map((e) => e.uid).filter((u) => !writer.knownKey((AtlasEntry.name ?? "signature-atlas.entry.v1"), u));
    for (let i = 0; i < uids.length; i += 20) {
      const chunk = uids.slice(i, i + 20);
      try {
        const res = await (pub as any)
          .select({ $key: true, uid: true, content_hash: true })
          .from(AtlasEntry)
          .where(or(...chunk.map((u) => eq("uid", u))))
          .ownedBy(importer)
          .limit(100)
          .fetch();
        for (const row of res.entities) {
          existing.set(row.uid.value, { key: row.$key, hash: row.content_hash.value });
          writer.seedKey((AtlasEntry.name ?? "signature-atlas.entry.v1"), row.uid.value, row.$key);
        }
      } catch (e) {
        errors.push(`seed query: ${(e as Error).message}`);
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    const prev = existing.get(e.uid);
    const unchanged = prev && prev.hash === e.contentHash;
    if (!prev && !writer.knownKey((AtlasEntry.name ?? "signature-atlas.entry.v1"), e.uid)) counts.created++;
    else if (unchanged) counts.extended++;
    else counts.patched++;
    writer.enqueue({
      uid: e.uid,
      schema: AtlasEntry,
      expiresInDays: EXPIRY_DAYS.atlas,
      extendOnly: !!unchanged,
      values: {
        uid: e.uid,
        selector: e.selector,
        kind: e.kind,
        text_signature: str128(e.text),
        source: e.source,
        sources_agreeing: i32(e.sourcesAgreeing),
        decode_verified: i32(e.decodeVerified),
        confidence: e.confidence,
        confidence_votes: i32(e.sourcesAgreeing + e.decodeVerified),
        submitter: addr(importer),
        content_hash: e.contentHash,
        import_run: runId,
        created_at: u64(now),
        payload: jsonBytes({ fullText: e.text, raw: e.raw, notes: e.decodeFailed ? `${e.decodeFailed} calldata samples failed to decode` : undefined }),
      },
    });
  }
  while (writer.pending > 0) await writer.flush();

  // ---- 5. import-run record
  writer.enqueue({
    uid: runId,
    schema: AtlasImportRun,
    expiresInDays: EXPIRY_DAYS.atlas,
    values: {
      run_id: runId,
      source: "4byte+openchain",
      source_commit: str128(JSON.stringify(fingerprints)),
      started_at: u64(startedAt),
      finished_at: u64(Math.floor(Date.now() / 1000)),
      payload: jsonBytes({ counts, errors: errors.slice(0, 50), cursor, diff: { created: counts.created, patched: counts.patched, extended: counts.extended } }),
    },
  });
  await writer.flush();
  writeFileSync(STATE, JSON.stringify(cursor, null, 2));
  console.log(JSON.stringify({ runId, importer, dryRun: writer.dryRun, counts, errors: errors.length }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
