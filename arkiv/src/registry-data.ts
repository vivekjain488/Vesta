import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { canonicalJson } from "@perpetua/core";

export const REGISTRY_SOURCE = "https://github.com/ethereum-lists/chains";
export const REGISTRY_LICENSE = `${REGISTRY_SOURCE}/blob/master/LICENSE`;
export const digest = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : canonicalJson(v)).digest("hex");
export const indexedText = (v: string) => { let s = "", size = 0; for (const character of v) { size += Buffer.byteLength(character); if (size > 128) break; s += character; } return s; };

/** Reserved/non-public ranges must not be contacted by the public RPC resolver. */
export function publicAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  // Global-unicast only. IPv4-mapped, loopback, ULA, link-local and documentation space are excluded.
  if (isIP(value) === 6) return /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith("2001:db8:") && !value.startsWith("2002:") && !/^2001:0*:/.test(value);
  return false;
}

export function classifyEndpoint(endpoint: string) {
  const requiresKey = /\$\{|[{}<>]|(?:api[_-]?key|access[_-]?token|project[_-]?id)=/i.test(endpoint);
  let host = "", transport = "unknown", eligible = false, reason = "invalid_url";
  try {
    const url = new URL(endpoint);
    host = url.hostname.toLowerCase(); transport = url.protocol.slice(0, -1);
    const ip = host.replace(/^\[|\]$/g, "");
    const privateHost = host === "localhost" || /\.(localhost|local|internal|invalid|test)$/.test(host) || (isIP(ip) !== 0 && !publicAddress(ip));
    reason = requiresKey ? "requires_key" : url.username || url.password ? "credentials_in_url" : privateHost ? "non_public_host" : transport !== "https" ? "https_required" : url.port && url.port !== "443" ? "nonstandard_port" : "public_https_unverified";
    eligible = reason === "public_https_unverified";
  } catch { /* Preserve the source row, but never execute malformed URLs. */ }
  return { host, transport, requiresKey, eligible, reason };
}

export interface ChainRecord {
  uid: string; chainId: number; name: string; shortName: string; networkType: "testnet" | "mainnet" | "unknown";
  networkTypeBasis: string; status: string; parent: string; nativeSymbol: string;
  rpcCount: number; publicHttpsCount: number; sourcePath: string; raw: Record<string, any>;
}
export interface RpcRecord {
  uid: string; chainId: number; endpoint: string; endpointHash: string; host: string; transport: string;
  requiresKey: boolean; executionEligible: boolean; eligibilityReason: string; sourceOrder: number; sourcePath: string;
}

export function normalizeRegistry(raws: unknown[]) {
  const chains: ChainRecord[] = [], rpcs: RpcRecord[] = [], seen = new Set<number>();
  let duplicateEndpoints = 0;
  for (const value of raws) {
    const c = value as Record<string, any>;
    if (!c || !Number.isSafeInteger(c.chainId) || c.chainId <= 0 || typeof c.name !== "string" || !c.name || typeof c.shortName !== "string" || !c.nativeCurrency || !Array.isArray(c.rpc) || c.rpc.some((r: unknown) => typeof r !== "string" || !r.trim())) throw new Error("Invalid upstream chain record; refusing a partial snapshot");
    if (seen.has(c.chainId)) throw new Error(`Duplicate upstream chain ID ${c.chainId}`);
    seen.add(c.chainId);
    const sourcePath = `_data/chains/eip155-${c.chainId}.json`;
    const localSeen = new Set<string>();
    let publicHttpsCount = 0;
    for (let i = 0; i < c.rpc.length; i++) {
      const endpoint: string = c.rpc[i];
      if (localSeen.has(endpoint)) { duplicateEndpoints++; continue; }
      localSeen.add(endpoint);
      const classification = classifyEndpoint(endpoint);
      if (classification.eligible) publicHttpsCount++;
      const endpointHash = digest(endpoint);
      rpcs.push({ uid: `eip155:${c.chainId}:${endpointHash}`, chainId: c.chainId, endpoint, endpointHash, host: classification.host,
        transport: classification.transport, requiresKey: classification.requiresKey, executionEligible: classification.eligible,
        eligibilityReason: classification.reason, sourceOrder: i, sourcePath });
    }
    const testnet = c.slip44 === 1 || /(?:testnet|test net|sepolia|holesky|hoodi|goerli|devnet|\btest\b)/i.test(c.name);
    const mainnet = /mainnet|main net/i.test(c.name) || c.chainId === 1 || (Number.isInteger(c.slip44) && c.slip44 !== 1);
    chains.push({ uid: `eip155:${c.chainId}`, chainId: c.chainId, name: c.name, shortName: c.shortName,
      networkType: testnet ? "testnet" : mainnet ? "mainnet" : "unknown", networkTypeBasis: testnet ? c.slip44 === 1 ? "slip44:1" : "name heuristic" : mainnet ? "mainnet name/slip44" : "not declared upstream",
      status: c.status ?? "active", parent: typeof c.parent?.chain === "string" ? c.parent.chain : "", nativeSymbol: String(c.nativeCurrency.symbol), rpcCount: localSeen.size, publicHttpsCount, sourcePath, raw: c });
  }
  chains.sort((a, b) => a.chainId - b.chainId);
  rpcs.sort((a, b) => a.chainId - b.chainId || a.sourceOrder - b.sourceOrder);
  return { chains, rpcs, duplicateEndpoints, sourceRpcCount: raws.reduce((sum: number, c: any) => sum + c.rpc.length, 0), contentHash: digest(raws.slice().sort((a: any, b: any) => a.chainId - b.chainId)) };
}
