import { inspectRpc, type RpcInspection } from "../../arkiv/src/rpc-inspect";
import type { RpcRecord } from "../../arkiv/src/registry-data";
import { CheckError, loadChainRpcs, manualHealthPublisher } from "./rpc-check";

const cache = new Map<string, { until: number; inspection: RpcInspection; stored: boolean; txHash?: string }>();
let running = 0;

function peersFor(row: RpcRecord, records: RpcRecord[]) {
  const others = records.filter((candidate) => candidate.endpointHash !== row.endpointHash && candidate.executionEligible && !candidate.requiresKey && candidate.transport === "https" && candidate.endpoint !== row.endpoint);
  const otherHosts = others.filter((candidate) => candidate.host !== row.host);
  return [...otherHosts, ...others.filter((candidate) => candidate.host === row.host)].slice(0, 3);
}

/** Inspect one registry RPC and store the readout on Arkiv. Results are cached for three minutes. */
export async function inspectRegistryRpc(chainId: number, snapshot: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new CheckError("Invalid RPC.");
  const key = `${chainId}:${hash}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return { chainId, snapshot, cached: true, inspection: hit.inspection, stored: hit.stored, txHash: hit.txHash ?? null };
  if (running >= 2) throw new CheckError("Inspection capacity reached; try again shortly.", 429);
  const records = await loadChainRpcs(chainId, snapshot, (rows) => rows.some((row) => row.endpointHash === hash) && rows.filter((row) => row.executionEligible && !row.requiresKey).length >= 4);
  const row = records.find((candidate) => candidate.endpointHash === hash);
  if (!row) throw new CheckError("That RPC is not in this chain and snapshot.");
  if (row.requiresKey || row.eligibilityReason === "credentials_in_url") throw new CheckError("Key or credentials required.");
  if (!row.executionEligible) throw new CheckError(row.eligibilityReason === "https_required" ? "Only public HTTPS endpoints can be inspected." : `Cannot inspect: ${row.eligibilityReason.replaceAll("_", " ")}.`);
  running++;
  try {
    const inspection = await inspectRpc(row, peersFor(row, records));
    const published = await manualHealthPublisher.publishInspect(chainId, hash, inspection);
    const stored = cache.set(key, { until: Date.now() + 180_000, inspection, stored: published.stored, txHash: published.stored ? published.txHash : undefined }).get(key)!;
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return { chainId, snapshot, cached: false, inspection, stored: stored.stored, txHash: stored.txHash ?? null };
  } finally { running--; }
}
