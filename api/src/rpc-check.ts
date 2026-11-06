import { registryRpcs } from "@perpetua/arkiv";
import { probeRpc, type Probe } from "../../arkiv/src/rpc-health";
import type { RpcRecord } from "../../arkiv/src/registry-data";

const cache = new Map<string, { until: number; result: Probe }>();
const inflight = new Map<string, Promise<Probe>>();
const hostBlockedUntil = new Map<string, number>();
let running = 0;
const MAX_CONCURRENT = 4;
export class CheckError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export function validateRpcHashes(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10 || value.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new CheckError("Select 1 to 10 valid RPCs.");
  if (new Set(value).size !== value.length) throw new CheckError("Duplicate RPC selection.");
  return value;
}
async function one(row: RpcRecord): Promise<{ sample?: Probe; message?: string; cached?: boolean }> {
  if (row.requiresKey || row.eligibilityReason === "credentials_in_url") return { message: "Key or credentials required" };
  if (!row.executionEligible) return { message: row.eligibilityReason === "https_required" ? "Only public HTTPS endpoints can be checked" : `Cannot check: ${row.eligibilityReason.replaceAll("_", " ")}` };
  const key = `${row.chainId}:${row.endpointHash}`, now = Date.now(), prior = cache.get(key);
  if (prior && prior.until > now) return { sample: prior.result, cached: true };
  const pending = inflight.get(key); if (pending) return { sample: await pending, cached: true };
  if ((hostBlockedUntil.get(row.host) ?? 0) > now) return { message: "Provider cooldown active; try again shortly" };
  if (running >= MAX_CONCURRENT) return { message: "Check capacity reached; try again shortly" };
  hostBlockedUntil.set(row.host, now + 1000);
  running++;
  const task = probeRpc(row);
  inflight.set(key, task);
  try {
    const sample = await task;
    cache.set(key, { until: Date.now() + 60_000, result: sample });
    if (sample.outcome === "rate_limited") {
      const raw = sample.headers["retry-after"], seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 0, date = raw ? Date.parse(raw) : NaN;
      const wait = seconds ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 300_000;
      hostBlockedUntil.set(row.host, Date.now() + Math.max(60_000, Math.min(wait, 3600_000)));
    }
    if (cache.size > 5000) for (const [k, v] of cache) if (v.until <= Date.now()) cache.delete(k);
    if (hostBlockedUntil.size > 5000) for (const [k, v] of hostBlockedUntil) if (v <= Date.now()) hostBlockedUntil.delete(k);
    return { sample };
  } finally { running--; inflight.delete(key); }
}
/** Only check verified records from the chosen completed Arkiv snapshot, never a caller-supplied URL. */
export async function checkSelectedRpcs(chainId: number, snapshot: string, hashes: string[]) {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !/^[a-f0-9]{64}$/.test(snapshot)) throw new CheckError("Invalid chain or snapshot.");
  validateRpcHashes(hashes);
  let after: number | undefined; const records: RpcRecord[] = [];
  do {
    const page = await registryRpcs(chainId, { snapshot, after, limit: 100 });
    records.push(...page.rows); after = page.nextAfter ?? undefined;
    if (records.length > 2000) throw new CheckError("Too many RPCs on this chain.");
  } while (after !== undefined && !hashes.every((hash) => records.some((r) => r.endpointHash === hash)));
  const selected = hashes.map((hash) => records.find((r) => r.endpointHash === hash));
  if (selected.some((r) => !r)) throw new CheckError("A selected RPC is not in this chain and snapshot.");
  const results: Record<string, Awaited<ReturnType<typeof one>>> = {};
  // Each group uses distinct hosts. Repeated hosts are checked in later groups with a short pause.
  const remaining = [...selected] as RpcRecord[];
  while (remaining.length) {
    const hosts = new Set<string>(), group: RpcRecord[] = [];
    for (let i = 0; i < remaining.length && group.length < MAX_CONCURRENT;) {
      const row = remaining[i]; if (hosts.has(row.host)) { i++; continue; }
      hosts.add(row.host); group.push(row); remaining.splice(i, 1);
    }
    const values = await Promise.all(group.map(one)); group.forEach((row, index) => { results[row.endpointHash] = values[index]; });
    if (remaining.length) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { chainId, snapshot, results };
}
