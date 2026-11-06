/**
 * RPC health history on Arkiv: one entity per probe (monitor or manual check), kept 30 days.
 * Availability and uptime are computed from these entities, so anyone can recompute them from Arkiv
 * (filtered by the health writer's address; Arkiv attributes are public and anyone can write look-alike rows).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { and, asc, eq, gt } from "@arkiv-network/sdk/query";
import { bool, bytes, defineSchema, str, u64 as u64Col } from "@arkiv-network/sdk/schema";
import { getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arkivChain, arkivPublic } from "./client";
import { jsonBytes, u64 } from "./schemas";
import type { Probe } from "./rpc-health";
import type { RpcInspection } from "./rpc-inspect";

export const RpcHealthSample = defineSchema("perpetua.rpc-health.v1", {
  uid: str().indexed(),
  chain_id: u64Col().indexed(),
  endpoint_hash: str().indexed(),
  at_ms: u64Col().indexed(),
  ok: bool().indexed(),
  latency_ms: u64Col().indexed(),
  outcome: str().indexed(),
  http_status: u64Col().indexed(), // 0 = no HTTP response
  source: str().indexed(), // monitor | manual
  vantage: str().indexed(),
});

/** One deeper readout per opened endpoint: block lag, head age, archive, batch, TLS, client version. */
export const RpcHealthInspect = defineSchema("perpetua.rpc-health.inspect.v1", {
  uid: str().indexed(),
  chain_id: u64Col().indexed(),
  endpoint_hash: str().indexed(),
  at_ms: u64Col().indexed(),
  payload: bytes(),
});

export interface StoredSample { chainId: number; endpointHash: string; at: number; ok: boolean; latencyMs: number; outcome: string; httpStatus?: number; source: string }

const key = () => (process.env.ARKIV_HEALTH_PRIVATE_KEY ?? process.env.ARKIV_MARKET_PRIVATE_KEY) as Hex | undefined;
/** Readers trust only this writer's rows. */
export function healthWriter(): Address | null {
  const explicit = process.env.ARKIV_HEALTH_WRITER_ADDRESS ?? (process.env.ARKIV_HEALTH_PRIVATE_KEY ? undefined : process.env.ARKIV_MARKET_WRITER_ADDRESS);
  if (explicit) return getAddress(explicit);
  const k = key();
  return k ? privateKeyToAccount(k).address : null;
}

const column = (v: any) => v?.value ?? v;

// ------------------------------------------------------------------------------------------------- write
interface Queue { items: (StoredSample & { uid: string })[]; published: number; lastTx?: string; lastError?: string; failures?: number; nextTryAt?: number }

/** Durable queue + batched writes (one transaction per flush). One instance per process (separate queue files). */
/** Arkiv nodes reject query pages above 100 rows. */
const PAGE = 100;
const MIN_BALANCE_WEI = 1_000_000_000_000_000n; // 0.001 ETH on Arkiv: below this, stop writing instead of failing

export class RpcHealthPublisher {
  private readonly file: string;
  private q: Queue;
  private busy = false;
  private lastFlush = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(name: string, private readonly vantage = process.env.RPC_HEALTH_VANTAGE ?? "perpetua-api") {
    this.file = resolve(process.env.PERPETUA_STATE_DIR ?? ".perpetua", `rpc-health-arkiv-${name}.json`);
    this.q = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { items: [], published: 0 };
    this.trim();
  }
  get enabled() { return Boolean(key()); }
  status() { return { enabled: this.enabled, queued: this.q.items.length, published: this.q.published, lastTx: this.q.lastTx ?? null, lastError: this.q.lastError ?? null, writer: healthWriter() }; }
  private save() { mkdirSync(dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; writeFileSync(tmp, JSON.stringify(this.q), { mode: 0o600 }); renameSync(tmp, this.file); }

  enqueue(chainId: number, endpointHash: string, probe: Probe, source: "monitor" | "manual") {
    if (!this.enabled) return;
    const uid = `${chainId}:${endpointHash}:${probe.at}`;
    if (this.q.items.some((i) => i.uid === uid)) return;
    this.q.items.push({ uid, chainId, endpointHash, at: probe.at, ok: probe.ok, latencyMs: Math.max(0, Math.round(probe.latencyMs)), outcome: probe.outcome, httpStatus: probe.httpStatus, source });
    this.trim();
    this.save();
  }
  /** Bounded backlog: only the last 24h matter for availability, so never pay to publish anything older. */
  private trim() { const cutoff = Date.now() - 24 * 3600_000; this.q.items = this.q.items.filter((i) => i.at >= cutoff).slice(-2000); }

  private enqueueWork<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Store one inspection entity. Serialized with sample flushes so the writer nonce does not collide. */
  publishInspect(chainId: number, endpointHash: string, inspection: RpcInspection) {
    if (!this.enabled) return Promise.resolve({ stored: false as const, reason: "no writer key" });
    return this.enqueueWork(async () => {
      try {
        const client: any = createWalletClient({ chain: arkivChain(), transport: http(), account: privateKeyToAccount(key()!) });
        const uid = `${chainId}:${endpointHash}:${inspection.at}`;
        const result = await client.executeBatch({ creates: [{ schema: RpcHealthInspect, values: { uid, chain_id: u64(BigInt(chainId)), endpoint_hash: endpointHash, at_ms: u64(BigInt(inspection.at)), payload: jsonBytes(inspection) }, expiration: ExpirationTime.fromDays(30) }], patches: [], extensions: [] });
        this.q.lastTx = result.txHash; this.q.lastError = undefined; this.save();
        return { stored: true as const, txHash: result.txHash as string };
      } catch (e) {
        this.q.lastError = String((e as Error).message).replace(/https?:\/\/\S+/g, "[endpoint]").split("\n")[0].slice(0, 200);
        this.save();
        return { stored: false as const, reason: this.q.lastError };
      }
    });
  }

  /** Publish queued samples in one transaction when the batch is full or `minIntervalMs` has passed. */
  flush(opts: { minIntervalMs?: number; minBatch?: number; maxBatch?: number } = {}) {
    return this.enqueueWork(() => this.flushNow(opts));
  }

  private async flushNow(opts: { minIntervalMs?: number; minBatch?: number; maxBatch?: number } = {}) {
    const { minIntervalMs = 60_000, minBatch = 12, maxBatch = 12 } = opts;
    if (!this.enabled || this.busy || !this.q.items.length) return null;
    if (Date.now() < (this.q.nextTryAt ?? 0)) return null; // backing off after a failed write
    if (this.q.items.length < minBatch && Date.now() - this.lastFlush < minIntervalMs) return null;
    this.busy = true;
    const batch = this.q.items.slice(0, maxBatch);
    try {
      const account = privateKeyToAccount(key()!);
      const balance: bigint = await (arkivPublic() as any).getBalance({ address: account.address });
      if (balance < MIN_BALANCE_WEI) throw new Error(`health writer ${account.address} balance too low (${Number(balance) / 1e18} ETH on Arkiv); top it up to resume`);
      const client: any = createWalletClient({ chain: arkivChain(), transport: http(), account });
      const creates = batch.map((s) => ({
        schema: RpcHealthSample,
        values: { uid: s.uid, chain_id: u64(BigInt(s.chainId)), endpoint_hash: s.endpointHash, at_ms: u64(BigInt(s.at)), ok: s.ok, latency_ms: u64(BigInt(s.latencyMs)), outcome: s.outcome, http_status: u64(BigInt(s.httpStatus ?? 0)), source: s.source, vantage: this.vantage },
        expiration: ExpirationTime.fromDays(8), // the endpoint detail view reads 7 days
      }));
      const result = await client.executeBatch({ creates, patches: [], extensions: [] });
      const done = new Set(batch.map((b) => b.uid));
      this.q.items = this.q.items.filter((i) => !done.has(i.uid));
      this.q.published += batch.length; this.q.lastTx = result.txHash; this.q.lastError = undefined; this.q.failures = 0; this.q.nextTryAt = 0;
      this.lastFlush = Date.now(); this.save();
      return { published: batch.length, txHash: result.txHash as string };
    } catch (e) {
      // Exponential backoff (2 min .. 2 h): a failing write must never keep spending gas every minute.
      this.q.failures = (this.q.failures ?? 0) + 1;
      this.q.nextTryAt = Date.now() + Math.min(2 * 3600_000, 120_000 * 2 ** (this.q.failures - 1));
      this.q.lastError = String((e as Error).message).replace(/https?:\/\/\S+/g, "[endpoint]").split("\n")[0].slice(0, 200);
      this.lastFlush = Date.now(); this.save();
      return null;
    } finally { this.busy = false; }
  }
}

// ------------------------------------------------------------------------------------------------- read
const cache = new Map<string, { at: number; samples: StoredSample[] }>();
/** All of the writer's samples for a chain since `sinceMs` (paged, cached 30s). */
export async function arkivHealthSamples(chainId: number, sinceMs = Date.now() - 24 * 3600_000): Promise<StoredSample[]> {
  const writer = healthWriter();
  if (!writer) return [];
  const cacheKey = `${chainId}:${Math.floor(sinceMs / 60_000)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 30_000) return hit.samples;
  const out: StoredSample[] = [];
  let after = BigInt(Math.max(0, sinceMs - 1));
  for (let page = 0; page < 25; page++) {
    const result = await (arkivPublic() as any).select().from(RpcHealthSample)
      .where(and(eq("chain_id", u64(BigInt(chainId))), gt("at_ms", u64(after))))
      .createdBy(writer).orderBy(asc("at_ms")).limit(PAGE).fetch();
    for (const r of result.entities) {
      out.push({ chainId: Number(column(r.chain_id)), endpointHash: String(column(r.endpoint_hash)), at: Number(column(r.at_ms)), ok: Boolean(column(r.ok)), latencyMs: Number(column(r.latency_ms)), outcome: String(column(r.outcome)), httpStatus: Number(column(r.http_status)) || undefined, source: String(column(r.source)) });
    }
    if (result.entities.length < PAGE) break;
    after = BigInt(out[out.length - 1].at);
  }
  cache.set(cacheKey, { at: Date.now(), samples: out });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return out;
}

function sampleOf(r: any): StoredSample {
  return { chainId: Number(column(r.chain_id)), endpointHash: String(column(r.endpoint_hash)), at: Number(column(r.at_ms)), ok: column(r.ok) === true, latencyMs: Number(column(r.latency_ms)), outcome: String(column(r.outcome)), httpStatus: Number(column(r.http_status)) || undefined, source: String(column(r.source)) };
}

/** One endpoint's samples since `sinceMs`, oldest first. */
export async function arkivEndpointSamples(chainId: number, endpointHash: string, sinceMs = Date.now() - 7 * 24 * 3600_000): Promise<StoredSample[]> {
  const writer = healthWriter();
  if (!writer || !/^[a-f0-9]{64}$/.test(endpointHash)) return [];
  const out: StoredSample[] = [];
  let after = BigInt(Math.max(0, sinceMs - 1));
  for (let page = 0; page < 20; page++) {
    const result = await (arkivPublic() as any).select().from(RpcHealthSample)
      .where(and(eq("chain_id", u64(BigInt(chainId))), eq("endpoint_hash", endpointHash), gt("at_ms", u64(after))))
      .createdBy(writer).orderBy(asc("at_ms")).limit(PAGE).fetch();
    for (const r of result.entities) out.push(sampleOf(r));
    if (result.entities.length < PAGE) break;
    after = BigInt(out[out.length - 1].at);
  }
  return out;
}

function decodeInspect(value: unknown): RpcInspection | null {
  try {
    const encoded = (value as any)?.value ?? value;
    const bytes = typeof encoded === "string" ? Buffer.from(encoded.replace(/^0x/, ""), "hex") : Buffer.from(encoded);
    const data = JSON.parse(bytes.toString("utf8"));
    if (!data || typeof data.at !== "number") return null;
    return data as RpcInspection;
  } catch { return null; }
}

/** Newest stored inspection for one endpoint, if the writer has published one. */
export async function latestInspection(chainId: number, endpointHash: string): Promise<RpcInspection | null> {
  const writer = healthWriter();
  if (!writer || !/^[a-f0-9]{64}$/.test(endpointHash)) return null;
  let after = BigInt(Date.now() - 30 * 24 * 3600_000);
  let latest: RpcInspection | null = null;
  for (let page = 0; page < 8; page++) {
    const result = await (arkivPublic() as any).select().from(RpcHealthInspect)
      .where(and(eq("chain_id", u64(BigInt(chainId))), eq("endpoint_hash", endpointHash), gt("at_ms", u64(after))))
      .createdBy(writer).orderBy(asc("at_ms")).limit(100).fetch();
    for (const r of result.entities) {
      const decoded = decodeInspect(r.payload);
      if (decoded) latest = decoded;
      after = BigInt(Number(column(r.at_ms)));
    }
    if (result.entities.length < 100) break;
  }
  return latest;
}
