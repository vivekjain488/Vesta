import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { custom, type Transport } from "viem";
import { classifyEndpoint, publicAddress } from "./registry-data";
import { registryChain, registryOwner } from "./registry-queries";

/** DNS is checked and pinned to the TLS request, preventing redirect/DNS-rebinding SSRF during probes. */
export async function publicRpcRequest(endpoint: string, body: unknown, timeoutMs = 7000): Promise<any> {
  if (!classifyEndpoint(endpoint).eligible) throw new Error("RPC endpoint is not eligible for public execution");
  const url = new URL(endpoint), host = url.hostname.replace(/^\[|\]$/g, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([lookup(host, { all: true, verbatim: true }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("RPC DNS lookup timed out")), timeoutMs); })]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new Error("RPC DNS resolved to a non-public address");
  const selected = addresses.find((a) => a.family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = httpsRequest(url, { method: "POST", agent: false, family: selected.family, signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json", "content-length": bytes.length }, lookup: ((_hostname: string, options: any, cb: any) => options.all ? cb(null, [selected]) : cb(null, selected.address, selected.family)) as any }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`RPC HTTP ${response.statusCode}`)); return; }
      const parts: Buffer[] = []; let size = 0;
      response.on("data", (part: Buffer) => { size += part.length; if (size > 128 * 1024) req.destroy(new Error("RPC response is too large")); else parts.push(part); });
      response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch { reject(new Error("RPC returned invalid JSON")); } });
      response.on("error", reject);
    });
    req.on("error", reject); req.end(bytes);
  });
}

const cache = new Map<string, { expires: number; value: ResolvedRpc }>();
export interface ResolvedRpc { chainId: number; endpoint: string; snapshot: string; chainEntityKey: string; rpcEntityKey: string; writer: string; checkedAtMs: number; source: "arkiv" }
export async function resolveRegistryRpc(chainId: number, options: { fresh?: boolean } = {}): Promise<ResolvedRpc> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid chain ID");
  const key = `${registryOwner()}:${chainId}`, cached = cache.get(key);
  if (!options.fresh && cached && cached.expires > Date.now()) return cached.value;
  const registry = await registryChain(chainId);
  if (registry.ageMs < -1000 || registry.ageMs > 48 * 3600_000) throw new Error("Registry import is stale; refusing to select a runtime RPC");
  if (registry.chain.status !== "active") throw new Error("Registry chain is not active");
  const endpoints = registry.rpcs.filter((r) => r.executionEligible && !r.requiresKey && r.transport === "https").slice(0, 5);
  for (const row of endpoints) {
    try {
      const result = await publicRpcRequest(row.endpoint, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
      if (result.id !== 1 || result.error || !/^0x[0-9a-f]+$/i.test(result.result) || BigInt(result.result) !== BigInt(chainId)) continue;
      const resolved: ResolvedRpc = { chainId, endpoint: row.endpoint, snapshot: registry.snapshot, chainEntityKey: registry.chain.entityKey, rpcEntityKey: row.entityKey, writer: registry.writer, checkedAtMs: Date.now(), source: "arkiv" };
      cache.set(key, { expires: Date.now() + 60_000, value: resolved }); return resolved;
    } catch { /* Try the next public candidate; never substitute a hardcoded upstream URL. */ }
  }
  throw new Error(`No reachable, chain-ID-verified public HTTPS RPC for chain ${chainId}`);
}

export function isLoopbackRpc(endpoint: string) {
  try { const u = new URL(endpoint); return ["http:", "https:"].includes(u.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname); } catch { return false; }
}
export async function projectRpc(chainId: number, configured?: string) {
  if (chainId === 31337) { if (!configured || !isLoopbackRpc(configured)) throw new Error("Local Anvil chain 31337 requires an explicit loopback RPC; it collides with public GoChain"); return { endpoint: configured, source: "local" as const }; }
  if (process.env.RPC_DISCOVERY === "env") { if (!configured) throw new Error("Explicit RPC is missing"); return { endpoint: configured, source: "env" as const }; }
  return resolveRegistryRpc(chainId);
}

/** Lazy async discovery fits viem's synchronous client factory; discovery is refreshed every minute. */
export function projectTransport(chainId: number, configured: string): Transport {
  if (chainId === 31337 || process.env.RPC_DISCOVERY === "env") {
    return custom({ request: async ({ method, params }) => {
      const resolved = await projectRpc(chainId, configured);
      const r = await fetch(resolved.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }), signal: AbortSignal.timeout(15_000) });
      const data: any = await r.json(); if (!r.ok || data.error) throw Object.assign(new Error(data.error?.message ?? `RPC HTTP ${r.status}`), { code: data.error?.code }); return data.result;
    } }, { retryCount: 0 });
  }
  return custom({ request: async ({ method, params }) => {
    const resolved = await resolveRegistryRpc(chainId);
    const data = await publicRpcRequest(resolved.endpoint, { jsonrpc: "2.0", id: 1, method, params: params ?? [] }, 15_000);
    if (data.error) throw Object.assign(new Error(data.error.message), { code: data.error.code }); return data.result;
  } }, { retryCount: 0 });
}
