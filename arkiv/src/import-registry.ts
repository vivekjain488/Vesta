/** Pinned, resumable full-corpus import. Only a verified complete snapshot becomes the public head. */
import "dotenv/config";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createWalletClient, ENTITY_EVENTS_ABI, ExpirationTime } from "@arkiv-network/sdk";
import { and, asc, eq, gt } from "@arkiv-network/sdk/query";
import { decodeEventLog, http, keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arkivChain, arkivPublic } from "./client";
import { RegistryChain, RegistryHead, RegistryRpc, RegistrySnapshot } from "./registry-schemas";
import { digest, indexedText, normalizeRegistry, REGISTRY_SOURCE, type ChainRecord, type RpcRecord } from "./registry-data";
import { jsonBytes, u64 } from "./schemas";

const root = resolve(new URL("../..", import.meta.url).pathname);
const directory = resolve(process.env.PERPETUA_STATE_DIR ?? resolve(root, ".perpetua"));
const value = (v: any) => v?.value ?? v;
const atomic = (file: string, data: unknown) => { writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 }); renameSync(`${file}.tmp`, file); };
const git = (folder: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", folder, ...args], { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
interface Job { nonce: number; ids: string[]; raw?: Hex; hash?: Hex; done?: boolean }
interface State { version: 1; owner: string; snapshot: string; commit: string; generation: number; keys: Record<string, Hex>; jobs: Job[]; phase: "staging" | "complete"; control?: { label: string; raw: Hex; hash: Hex }; receipts: { hash: string; rows: number; gasWei: string }[] }
export interface RegistryWrite { id: string; schema: any; values: any }

export function registryWrites(chains: ChainRecord[], rpcs: RpcRecord[], snapshot: string): RegistryWrite[] {
  const priority = [16602, 16661, 8453, 84532, 1, 42161];
  const rank = (id: number) => priority.includes(id) ? priority.indexOf(id) : 100;
  const ordered = [...chains].sort((a, b) => rank(a.chainId) - rank(b.chainId) || a.chainId - b.chainId);
  const rows: RegistryWrite[] = [];
  for (const c of ordered) {
    const payload = { ...c, source: REGISTRY_SOURCE };
    rows.push({ id: `chain:${c.uid}`, schema: RegistryChain, values: { uid: c.uid, snapshot_id: snapshot, chain_id: u64(BigInt(c.chainId)), name: indexedText(c.name), search_name: indexedText(c.name.toLowerCase()), short_name: indexedText(c.shortName), network_type: c.networkType, status: c.status, parent: indexedText(c.parent), native_symbol: indexedText(c.nativeSymbol), rpc_count: u64(BigInt(c.rpcCount)), public_https_count: u64(BigInt(c.publicHttpsCount)), content_hash: digest(payload), payload: jsonBytes(payload) } });
    for (const r of rpcs.filter((r) => r.chainId === c.chainId)) {
      const body = { ...r, source: REGISTRY_SOURCE };
      rows.push({ id: `rpc:${r.uid}`, schema: RegistryRpc, values: { uid: r.uid, snapshot_id: snapshot, chain_id: u64(BigInt(r.chainId)), endpoint_hash: r.endpointHash, host: indexedText(r.host), transport: r.transport, requires_key: r.requiresKey, execution_eligible: r.executionEligible, source_order: u64(BigInt(r.sourceOrder)), content_hash: digest(body), payload: jsonBytes(body) } });
    }
  }
  return rows;
}

/** Hex/ABI framing makes the RPC request much larger than the JSON payload alone. */
export function registryBatches(rows: RegistryWrite[]) {
  const batches: RegistryWrite[][] = []; let batch: RegistryWrite[] = [], bytes = 0;
  for (const row of rows) {
    const estimate = row.values.payload.byteLength + Object.keys(row.values).length * 240 + 800;
    if (batch.length && (batch.length >= 8 || bytes + estimate > 24_000)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(row); bytes += estimate;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function existingRows(pub: any, schema: any, snapshot: string, owner: string) {
  const rows: any[] = []; let cursor: string | undefined;
  for (;;) {
    const predicates = [eq("snapshot_id", snapshot), ...(cursor ? [gt("uid", cursor)] : [])];
    const page = await pub.select({ $key: true, uid: true }).from(schema).where(and(...predicates)).ownedBy(owner).orderBy(asc("uid")).limit(100).fetch();
    rows.push(...page.entities); if (page.entities.length < 100) break;
    cursor = value(page.entities.at(-1).uid);
  }
  return rows;
}

export async function importRegistry(options: { dryRun?: boolean } = {}) {
  mkdirSync(directory, { recursive: true });
  const lock = resolve(directory, "registry-import.pid");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8")); let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* stale lock */ }
    if (alive) throw new Error(`Registry importer already running (PID ${pid})`);
    unlinkSync(lock);
  }
  const fd = openSync(lock, "wx"); writeFileSync(fd, String(process.pid)); closeSync(fd);
  try {
    const file = resolve(directory, "registry-import.json");
    let state: State | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    const source = resolve(directory, "registry-source");
    if (!existsSync(resolve(source, ".git"))) execFileSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", `${REGISTRY_SOURCE}.git`, source], { timeout: 180_000, stdio: "inherit" });
    if (git(source, "remote", "get-url", "origin") !== `${REGISTRY_SOURCE}.git`) throw new Error("Unexpected upstream Git remote");
    const pending = state?.phase === "staging" || Boolean(state?.control);
    if (!pending) git(source, "fetch", "--depth", "1", "origin", "master");
    const commit = pending ? state!.commit : git(source, "rev-parse", "FETCH_HEAD");
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid upstream Git commit");
    git(source, "checkout", "--detach", commit);
    if (git(source, "status", "--porcelain", "--untracked-files=no")) throw new Error("Cached upstream files were modified; refusing false commit provenance");
    const license = readFileSync(resolve(source, "LICENSE"), "utf8");
    if (!license.startsWith("MIT License") || !license.includes("Permission is hereby granted")) throw new Error("Upstream license changed; review republishing rights before import");
    const folder = resolve(source, "_data/chains");
    const files = readdirSync(folder).filter((f) => /^eip155-\d+\.json$/.test(f)).sort();
    const raw = files.map((f) => { const c = JSON.parse(readFileSync(resolve(folder, f), "utf8")); if (f !== `eip155-${c.chainId}.json`) throw new Error("Upstream filename/chain ID mismatch"); return c; });
    if (raw.length < 2000) throw new Error("Unexpectedly small upstream corpus; refusing to replace the registry");
    const generation = pending ? state!.generation : Math.floor(Date.now() / (7 * 86400_000));
    const data = normalizeRegistry(raw), snapshot = digest({ version: 1, commit, hash: data.contentHash, generation });
    const writes = registryWrites(data.chains, data.rpcs, snapshot);
    const report = { source: REGISTRY_SOURCE, sourceCommit: commit, sourceHash: data.contentHash, snapshot, chains: data.chains.length, rpcEntries: data.rpcs.length, upstreamRpcEntries: data.sourceRpcCount, duplicateEndpoints: data.duplicateEndpoints, license: "MIT", sourceLicense: license, at: new Date().toISOString() };
    atomic(resolve(directory, "registry-source-report.json"), report);
    console.log(`[registry] ${report.chains} chains; ${report.rpcEntries} unique RPCs; commit ${commit}`);
    if (options.dryRun) return report;
    const pk = process.env.ARKIV_REGISTRY_PRIVATE_KEY as Hex | undefined;
    if (!pk) throw new Error("ARKIV_REGISTRY_PRIVATE_KEY is required for live import; use --dry-run to inspect source only");
    const account = privateKeyToAccount(pk), pub: any = arkivPublic();
    if (process.env.ARKIV_REGISTRY_WRITER_ADDRESS?.toLowerCase() !== account.address.toLowerCase()) throw new Error("Registry writer key/address mismatch");
    if (state?.phase === "staging" && (state.snapshot !== snapshot || state.owner !== account.address)) throw new Error("Refusing to change writer/source during a pending import");
    if (!state || state.snapshot !== snapshot || state.owner !== account.address) state = { version: 1, owner: account.address, snapshot, commit, generation, keys: {}, jobs: [], phase: "staging", receipts: [] };
    const journal = state;
    const save = () => atomic(file, journal);
    const contexts = new Map<number, Job>();
    let controlLabel: string | undefined;
    const transport: any = (config: any) => {
      const base = http(undefined, { timeout: 30_000, retryCount: 0 })(config);
      return { ...base, request: async (args: any, opts: any) => {
        if (args.method === "eth_sendRawTransaction") {
          const raw = args.params[0] as Hex, nonce = Number(parseTransaction(raw).nonce), job = contexts.get(nonce);
          if (job) { job.raw = raw; job.hash = keccak256(raw); save(); } // Before broadcast, including timeouts.
          else if (controlLabel) { journal.control = { label: controlLabel, raw, hash: keccak256(raw) }; save(); }
        }
        return base.request(args, opts);
      } };
    };
    const client: any = createWalletClient({ account, chain: arkivChain(), transport });
    const control = async (label: string, operations: any) => {
      controlLabel = label;
      try { const result = await client.executeBatch(operations); delete journal.control; save(); return result; }
      finally { controlLabel = undefined; }
    };
    const byId = new Map(writes.map((r) => [r.id, r]));
    const ack = (job: Job, receipt: any) => {
      if (receipt.status !== "success") throw new Error(`Registry transaction reverted: ${receipt.transactionHash}`);
      const keys = receipt.logs.flatMap((log: any) => { try { const event = decodeEventLog({ abi: ENTITY_EVENTS_ABI, data: log.data, topics: log.topics }); return event.eventName === "EntityCreated" ? [event.args.entityKey] : []; } catch { return []; } });
      if (keys.length !== job.ids.length) throw new Error("Registry receipt entity count mismatch");
      job.ids.forEach((id, i) => { journal.keys[id] = keys[i]; }); job.done = true;
      journal.receipts.push({ hash: receipt.transactionHash, rows: job.ids.length, gasWei: String(receipt.gasUsed * receipt.effectiveGasPrice) });
      delete job.raw; save();
    };
    const run = async (job: Job) => {
      contexts.set(job.nonce, job);
      if (job.raw) {
        let receipt: any;
        try { receipt = await pub.getTransactionReceipt({ hash: job.hash }); } catch { /* may not have been broadcast */ }
        if (!receipt) { try { await pub.sendRawTransaction({ serializedTransaction: job.raw }); } catch { /* same raw transaction may already be known */ } receipt = await pub.waitForTransactionReceipt({ hash: job.hash, timeout: 120_000 }); }
        ack(job, receipt);
      } else {
        const creates = job.ids.map((id) => { const row = byId.get(id); if (!row) throw new Error("Journal row missing from pinned source"); return { schema: row.schema, values: row.values, expiration: ExpirationTime.fromDays(30) }; });
        const result = await client.executeBatch({ creates }, { nonce: job.nonce });
        ack(job, await pub.getTransactionReceipt({ hash: result.txHash }));
      }
      contexts.delete(job.nonce);
    };
    if (!journal.jobs.length && journal.phase !== "complete") {
      // Recover ownership-filtered natural keys even if the local cache was lost.
      const [chains, rpcs] = await Promise.all([existingRows(pub, RegistryChain, snapshot, account.address), existingRows(pub, RegistryRpc, snapshot, account.address)]);
      for (const [prefix, rows] of [["chain", chains], ["rpc", rpcs]] as const) for (const r of rows) { const id = `${prefix}:${value(r.uid)}`; if (journal.keys[id]) throw new Error("Duplicate registry UID in snapshot"); journal.keys[id] = r.$key; }
      let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
      journal.jobs = registryBatches(writes.filter((r) => !journal.keys[r.id])).map((batch) => ({ nonce: nonce++, ids: batch.map((r) => r.id) })); save();
    }
    const remaining = journal.jobs.filter((j) => !j.done);
    const concurrency = Number(process.env.REGISTRY_CONCURRENCY ?? 12);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("REGISTRY_CONCURRENCY must be 1–16");
    for (let i = 0; i < remaining.length; i += concurrency) {
      if (await pub.getBalance({ address: account.address }) < 50_000_000_000_000_000n) throw new Error("Registry writer balance is too low; top up and re-run to resume");
      const results = await Promise.allSettled(remaining.slice(i, i + concurrency).map(run));
      const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failure) throw failure.reason;
      console.log(`[registry] confirmed ${Object.keys(journal.keys).length}/${writes.length} entities`);
    }
    const [chainCount, rpcCount] = await Promise.all([pub.count().from(RegistryChain).where(eq("snapshot_id", snapshot)).ownedBy(account.address).fetch(), pub.count().from(RegistryRpc).where(eq("snapshot_id", snapshot)).ownedBy(account.address).fetch()]);
    if (Number(chainCount) !== data.chains.length || Number(rpcCount) !== data.rpcs.length) throw new Error("Arkiv row counts do not match complete source; head was not changed");
    if (journal.control) {
      const tx = journal.control; let receipt: any;
      try { receipt = await pub.getTransactionReceipt({ hash: tx.hash }); } catch { /* Unknown broadcast is replayed byte-for-byte. */ }
      if (!receipt) { try { await pub.sendRawTransaction({ serializedTransaction: tx.raw }); } catch { /* May already be known. */ } receipt = await pub.waitForTransactionReceipt({ hash: tx.hash, timeout: 120_000 }); }
      delete journal.control; save();
      if (receipt.status !== "success") throw new Error("Registry manifest/head transaction reverted; reconcile and retry");
    }
    const lookup = async (schema: any, uid: string) => { const result = await pub.select({ $key: true }).from(schema).where(eq("uid", uid)).ownedBy(account.address).limit(2).fetch(); if (result.entities.length > 1) throw new Error("Duplicate registry manifest/head"); return result.entities[0]?.$key; };
    const snapshotKey = await lookup(RegistrySnapshot, snapshot);
    if (!snapshotKey) await control("manifest", { creates: [{ schema: RegistrySnapshot, values: { uid: snapshot, snapshot_id: snapshot, status: "complete", source_commit: commit, source_hash: data.contentHash, chain_count: u64(chainCount), rpc_count: u64(rpcCount), published_at_ms: u64(BigInt(Date.now())), payload: jsonBytes(report) }, expiration: ExpirationTime.fromDays(30) }] });
    const headKey = await lookup(RegistryHead, "current");
    const head = { uid: "current", snapshot_id: snapshot, checked_at_ms: u64(BigInt(Date.now())), source_commit: commit, payload: jsonBytes({ ...report, writer: account.address }) };
    if (headKey) await control("head", { patches: [{ schema: RegistryHead, entityKey: headKey, set: head }], extensions: [{ entityKey: headKey, expiration: ExpirationTime.fromDays(30) }] });
    else await control("head", { creates: [{ schema: RegistryHead, values: head, expiration: ExpirationTime.fromDays(30) }] });
    journal.phase = "complete"; save();
    const evidence = { ...report, writer: account.address, confirmedChains: Number(chainCount), confirmedRpcs: Number(rpcCount), transactionCount: journal.receipts.length, gasWei: journal.receipts.reduce((n, r) => n + BigInt(r.gasWei), 0n).toString(), sampleEntities: Object.fromEntries(["chain:eip155:16602", "chain:eip155:1", "chain:eip155:8453"].map((id) => [id, journal.keys[id]])) };
    atomic(resolve(directory, "registry-live-verification.json"), evidence);
    console.log(JSON.stringify(evidence, null, 2));
    return evidence;
  } finally { if (existsSync(lock) && Number(readFileSync(lock, "utf8")) === process.pid) unlinkSync(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  importRegistry({ dryRun: process.argv.includes("--dry-run") }).catch((error) => {
    const secret = process.env.ARKIV_ACCESS_KEY ?? "";
    console.error(`[registry] ${String(error.message).split(secret || "\u0000").join("[redacted]").replace(/https?:\/\/\S+/g, "[endpoint]").slice(0, 800)}`);
    process.exitCode = 1;
  });
}
