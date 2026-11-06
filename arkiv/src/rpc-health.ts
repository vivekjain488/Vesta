import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, asc, eq, gt } from "@arkiv-network/sdk/query";
import { arkivPublic } from "./client";
import { RegistryRpc } from "./registry-schemas";
import { registryHead } from "./registry-queries";
import { digest, type RpcRecord } from "./registry-data";
import { publicRpcRequest } from "./registry-resolver";

export type Probe = { at: number; ok: boolean; latencyMs: number; outcome: string; httpStatus?: number; headers: Record<string, string> };
export type Health = { chainId: number; endpointHash: string; samples: Probe[] };
export type HealthFile = { version: 1; updatedAt: number; snapshot: string; entries: Record<string, Health> };
const file = () => resolve(process.env.PERPETUA_STATE_DIR ?? ".perpetua", "rpc-health.json");
export const healthKey = (chainId: number, hash: string) => `${chainId}:${hash}`;
export function readHealth(): HealthFile {
  try { const state = JSON.parse(readFileSync(file(), "utf8")); if (state.version === 1 && state.entries && typeof state.entries === "object") return state; } catch { /* not collected yet */ }
  return { version: 1, updatedAt: 0, snapshot: "", entries: {} };
}
export function saveHealth(state: HealthFile) {
  mkdirSync(resolve(file(), ".."), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, file());
}
export function healthSummary(entry: Health | undefined, now = Date.now()) {
  if (!entry?.samples.length) return null;
  const recent = entry.samples.filter((s) => s.at <= now && s.at >= now - 24 * 3600_000);
  const latest = entry.samples.at(-1)!;
  const successes = recent.filter((s) => s.ok);
  const latencies = successes.map((s) => s.latencyMs).sort((a, b) => a - b);
  return { latest, stale: now - latest.at > 2 * 3600_000, windowHours: 24, sampleCount: recent.length, successfulSamples: successes.length,
    sampledAvailabilityPercent: recent.length ? Math.round(successes.length * 10000 / recent.length) / 100 : null,
    medianLatencyMs: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null,
    samples: recent.map(({ at, ok, latencyMs }) => ({ at, ok, latencyMs })).sort((a, b) => a.at - b.at) };
}
export async function probeRpc(row: RpcRecord, request = publicRpcRequest): Promise<Probe> {
  const at = Date.now(), start = performance.now(); let httpStatus: number | undefined; let headers: Record<string, string> = {};
  try {
    const result = await request(row.endpoint, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, 7000, (status, h) => { httpStatus = status; headers = h; });
    if (result?.error) return { at, ok: false, latencyMs: Math.round(performance.now() - start), outcome: result.error.code === -32005 || result.error.code === 429 ? "rate_limited" : "rpc_error", httpStatus, headers };
    const valid = result?.jsonrpc === "2.0" && result.id === 1 && typeof result.result === "string" && /^0x[0-9a-f]+$/i.test(result.result);
    const outcome = !valid ? "invalid_response" : BigInt(result.result) !== BigInt(row.chainId) ? "wrong_chain" : "healthy";
    return { at, ok: outcome === "healthy", latencyMs: Math.round(performance.now() - start), outcome, httpStatus, headers };
  } catch (e) {
    const outcome = httpStatus === 429 ? "rate_limited" : httpStatus && httpStatus !== 200 ? "http_error" : /invalid JSON/i.test(String(e)) ? "invalid_response" : /timed out|abort/i.test(String(e)) ? "timeout" : /ENOTFOUND|EAI_AGAIN|DNS/i.test(String(e)) ? "dns_error" : "connection_error";
    return { at, ok: false, latencyMs: Math.round(performance.now() - start), outcome, httpStatus, headers };
  }
}
/** Read active RPC records from Arkiv in bounded pages; never fetch arbitrary URLs supplied by a caller. */
export async function loadProbeTargets() {
  const head = await registryHead(), pub: any = arkivPublic(); const rows: RpcRecord[] = []; let after: string | undefined;
  for (;;) {
    const filters = [eq("snapshot_id", head.snapshot), ...(after ? [gt("uid", after)] : [])];
    const page = await pub.select().from(RegistryRpc).where(and(...filters)).createdBy(head.writer).orderBy(asc("uid")).limit(100).fetch();
    for (const item of page.entities) {
      const value = item.payload?.value ?? item.payload;
      const data = JSON.parse(Buffer.from(typeof value === "string" ? value.slice(2) : value, typeof value === "string" ? "hex" : undefined).toString("utf8"));
      const hash = item.content_hash?.value ?? item.content_hash;
      if (digest(data) !== hash || data.uid !== (item.uid?.value ?? item.uid)) throw new Error("RPC payload integrity mismatch");
      rows.push(data);
    }
    if (page.entities.length < 100) break;
    after = page.entities.at(-1).uid?.value ?? page.entities.at(-1).uid;
  }
  if (rows.length !== head.rpcCount) throw new Error("Incomplete registry snapshot during health target load");
  return { snapshot: head.snapshot, rows };
}
