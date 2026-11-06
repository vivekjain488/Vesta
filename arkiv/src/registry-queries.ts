import { and, asc, eq, gt, startsWith, type Expression } from "@arkiv-network/sdk/query";
import { getAddress, type Address } from "viem";
import { arkivPublic } from "./client";
import { RegistryChain, RegistryHead, RegistryRpc, RegistrySnapshot } from "./registry-schemas";
import { digest, type ChainRecord, type RpcRecord } from "./registry-data";
import { u64 } from "./schemas";
import deployment from "../registry-deployment.json";

const column = (v: any) => v?.value ?? v;
export const registryCreator = () => getAddress(process.env.ARKIV_REGISTRY_WRITER_ADDRESS ?? deployment.writer);
const chainIdOf = (id: number) => { if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Chain ID must be a positive safe integer"); return id; };
function payload(row: any) {
  const encoded = column(row.payload), bytes = typeof encoded === "string" ? Buffer.from(encoded.slice(2), "hex") : Buffer.from(encoded);
  const data = JSON.parse(bytes.toString("utf8"));
  if (row.content_hash && digest(data) !== column(row.content_hash)) throw new Error("Registry content hash mismatch");
  return data;
}

/** @deprecated Use registryCreator; this address identifies the creator, not the current owner. */
export const registryOwner = registryCreator;

export async function registryHead(creator = registryCreator()) {
  const result = await (arkivPublic() as any).select().from(RegistryHead).where(eq("uid", "current")).createdBy(creator).limit(2).fetch();
  if (result.entities.length !== 1) throw new Error("No unique completed Arkiv registry is published yet");
  const row = result.entities[0], data = payload(row), snapshot = String(column(row.snapshot_id)), checkedAtMs = Number(column(row.checked_at_ms));
  if (!/^[a-f0-9]{64}$/.test(snapshot) || data.snapshot !== snapshot || data.sourceCommit !== column(row.source_commit)) throw new Error("Registry head provenance mismatch");
  const manifests = await (arkivPublic() as any).select().from(RegistrySnapshot).where(and(eq("snapshot_id", snapshot), eq("status", "complete"))).createdBy(creator).limit(2).fetch();
  if (manifests.entities.length !== 1) throw new Error("Registry head has no unique completed manifest");
  const manifest = manifests.entities[0];
  if (Number(column(manifest.chain_count)) !== data.chains || Number(column(manifest.rpc_count)) !== data.rpcEntries || column(manifest.source_hash) !== data.sourceHash || column(manifest.source_commit) !== data.sourceCommit) throw new Error("Registry completed manifest disagrees with its head");
  return { writer: creator, entityKey: row.$key as string, manifestEntityKey: manifest.$key as string, snapshot, checkedAtMs, ageMs: Date.now() - checkedAtMs, sourceCommit: String(column(row.source_commit)), chainCount: data.chains as number, rpcCount: data.rpcEntries as number, source: data.source as string, license: data.license as string };
}

async function view(snapshot?: string, creator = registryCreator()) {
  const head = await registryHead(creator);
  if (!snapshot || snapshot === head.snapshot) return head;
  if (!/^[a-f0-9]{64}$/.test(snapshot)) throw new Error("Invalid snapshot cursor");
  const rows = await (arkivPublic() as any).select().from(RegistrySnapshot).where(and(eq("snapshot_id", snapshot), eq("status", "complete"))).createdBy(creator).limit(2).fetch();
  if (rows.entities.length !== 1) throw new Error("Snapshot cursor is incomplete or expired");
  return { ...head, snapshot };
}

export async function registryChains(options: { chainId?: number; namePrefix?: string; networkType?: string; status?: string; parent?: string; after?: number; limit?: number; snapshot?: string; creator?: Address; /** @deprecated Use creator. */ owner?: Address } = {}) {
  const head = await view(options.snapshot, options.creator ?? options.owner), limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Page size must be 1–100");
  const filters: Expression[] = [eq("snapshot_id", head.snapshot)];
  if (options.chainId !== undefined) filters.push(eq("chain_id", u64(BigInt(chainIdOf(options.chainId)))));
  if (options.after !== undefined) filters.push(gt("chain_id", u64(BigInt(chainIdOf(options.after)))));
  if (options.namePrefix) { if (Buffer.byteLength(options.namePrefix) > 128) throw new Error("Name prefix is too long"); filters.push(startsWith("search_name", options.namePrefix.toLowerCase())); }
  if (options.networkType) filters.push(eq("network_type", options.networkType));
  if (options.status) filters.push(eq("status", options.status));
  if (options.parent) filters.push(eq("parent", options.parent));
  const result = await (arkivPublic() as any).select().from(RegistryChain).where(and(...filters)).createdBy(head.writer).orderBy(asc("chain_id")).limit(limit).fetch();
  const rows: (ChainRecord & { entityKey: string })[] = result.entities.map((r: any) => {
    const data = payload(r) as ChainRecord;
    if (data.chainId !== Number(column(r.chain_id)) || data.uid !== column(r.uid)) throw new Error("Registry chain payload/index mismatch");
    return { entityKey: r.$key as string, ...data };
  });
  return { ...head, rows, nextAfter: rows.length === limit ? rows.at(-1)!.chainId : null };
}

export async function registryRpcs(chainId: number, options: { transport?: string; requiresKey?: boolean; eligible?: boolean; limit?: number; after?: number; snapshot?: string; creator?: Address; /** @deprecated Use creator. */ owner?: Address } = {}) {
  chainIdOf(chainId); const head = await view(options.snapshot, options.creator ?? options.owner), limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || options.after !== undefined && (!Number.isSafeInteger(options.after) || options.after < 0)) throw new Error("Invalid RPC page size/cursor");
  const filters: Expression[] = [eq("snapshot_id", head.snapshot), eq("chain_id", u64(BigInt(chainId)))];
  if (options.transport) filters.push(eq("transport", options.transport));
  if (options.requiresKey !== undefined) filters.push(eq("requires_key", options.requiresKey));
  if (options.eligible !== undefined) filters.push(eq("execution_eligible", options.eligible));
  if (options.after !== undefined) filters.push(gt("source_order", u64(BigInt(options.after))));
  const result = await (arkivPublic() as any).select().from(RegistryRpc).where(and(...filters)).createdBy(head.writer).orderBy(asc("source_order")).limit(limit).fetch();
  const rows: (RpcRecord & { entityKey: string })[] = result.entities.map((r: any) => {
    const data = payload(r) as RpcRecord;
    if (data.chainId !== chainId || data.uid !== column(r.uid) || digest(data.endpoint) !== column(r.endpoint_hash)) throw new Error("Registry RPC payload/index mismatch");
    return { entityKey: r.$key as string, ...data };
  });
  return { ...head, rows, nextAfter: rows.length === limit ? rows.at(-1)!.sourceOrder : null };
}

export async function registryChain(chainId: number) {
  const chain = await registryChains({ chainId, limit: 2 });
  if (chain.rows.length !== 1) throw new Error("Chain is absent or duplicated in the current registry");
  const rpcs = await registryRpcs(chainId, { snapshot: chain.snapshot });
  return { ...chain, chain: chain.rows[0], rpcs: rpcs.rows };
}
