import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { classifyEndpoint, digest, indexedText, normalizeRegistry, publicAddress } from "../../../arkiv/src/registry-data";
import { registryBatches, registryWrites } from "../../../arkiv/src/import-registry";
import { isLoopbackRpc, projectRpc, publicRpcRequest, resolveRegistryRpc } from "../../../arkiv/src/registry-resolver";
import { registryChain } from "../../../arkiv/src/registry-queries";
import { lookup } from "node:dns/promises";
import { request } from "node:https";

const mocks = vi.hoisted(() => ({ responses: new Map<string, any>(), lookups: 0 }));
vi.mock("../../../arkiv/src/registry-queries", () => ({ registryOwner: () => "0x1111111111111111111111111111111111111111", registryChain: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]) }));
vi.mock("node:https", () => ({ request: vi.fn((url: URL, options: any, respond: (r: any) => void) => {
  const req: any = new EventEmitter();
  req.end = () => queueMicrotask(() => {
    options.lookup(url.hostname, { all: false }, (error: unknown, address: string) => { if (!error && address === "1.1.1.1") mocks.lookups++; });
    const response: any = new EventEmitter(); response.statusCode = 200; response.resume = () => {};
    respond(response); response.emit("data", Buffer.from(JSON.stringify(mocks.responses.get(url.hostname) ?? { jsonrpc: "2.0", id: 1, result: "0x40da" }))); response.emit("end");
  });
  req.destroy = (e: Error) => req.emit("error", e); return req;
}) }));
const raw = (id = 16602): any => ({ name: "0G Galileo Testnet", chain: "0G", chainId: id, networkId: id, shortName: "0g-test", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpc: ["https://rpc-one.example", "wss://rpc-one.example", "https://key.example/${API_KEY}"] });
const head = (id = 16602) => {
  const data = normalizeRegistry([raw(id)]);
  return { writer: "0x1111111111111111111111111111111111111111", snapshot: "ab".repeat(32), ageMs: 1000,
    chain: { ...data.chains[0], entityKey: "0xchain" }, rpcs: data.rpcs.map((r, i) => ({ ...r, entityKey: `0xrpc${i}` })) };
};
afterEach(() => { vi.clearAllMocks(); mocks.responses.clear(); mocks.lookups = 0; vi.mocked(lookup).mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as any); vi.unstubAllEnvs(); });

describe("full-corpus chain registry normalization", () => {
  it("preserves full source data, empty RPC lists and deprecated chain identities", () => {
    const a = raw(), b = { ...raw(1), name: "Ethereum Mainnet", shortName: "eth", status: "deprecated", rpc: [] };
    const data = normalizeRegistry([a, b]);
    expect(data.chains).toHaveLength(2); expect(data.rpcs).toHaveLength(3);
    expect(data.chains[0]).toMatchObject({ chainId: 1, status: "deprecated", networkType: "mainnet", rpcCount: 0, raw: b });
    expect(data.chains[1]).toMatchObject({ chainId: 16602, networkType: "testnet", publicHttpsCount: 1 });
  });
  it("deduplicates only an exact endpoint inside its chain and reports it", () => {
    const a = raw(); a.rpc.push(a.rpc[0]);
    const data = normalizeRegistry([a, raw(16661)]);
    expect(data.sourceRpcCount).toBe(7); expect(data.rpcs).toHaveLength(6); expect(data.duplicateEndpoints).toBe(1);
    expect(new Set(data.rpcs.map((r) => r.uid)).size).toBe(6);
  });
  it("rejects conflicting/unsafe chain IDs and malformed endpoints instead of publishing partial data", () => {
    for (const input of [[raw(), raw()], [{ ...raw(), chainId: Number.MAX_SAFE_INTEGER + 1 }], [{ ...raw(), rpc: [{}] }], [{ ...raw(), chainId: 0 }]]) expect(() => normalizeRegistry(input)).toThrow();
  });
  it("keeps indexed Unicode valid and stores full names and URLs in payloads", () => {
    const chain = { ...raw(), name: "😀".repeat(40), rpc: [`https://rpc.example/${"x".repeat(300)}`] };
    expect(Buffer.byteLength(indexedText(chain.name))).toBe(128);
    expect(Buffer.from(indexedText(chain.name)).toString("utf8")).toBe(indexedText(chain.name));
    const data = normalizeRegistry([chain]), writes = registryWrites(data.chains, data.rpcs, "ab".repeat(32));
    expect(JSON.parse(Buffer.from(writes[0].values.payload).toString()).name).toBe(chain.name);
    expect(JSON.parse(Buffer.from(writes[1].values.payload).toString()).endpoint).toBe(chain.rpc[0]);
    expect(writes[0].values.content_hash).toBe(digest(JSON.parse(Buffer.from(writes[0].values.payload).toString())));
  });
  it("has deterministic source/endpoint hashes independent of input chain ordering", () => {
    expect(normalizeRegistry([raw(1), raw(2)]).contentHash).toBe(normalizeRegistry([raw(2), raw(1)]).contentHash);
    expect(digest("https://rpc.example/A")).not.toBe(digest("https://rpc.example/a"));
  });
  it("bounds writes for hex/ABI request overhead rather than just counting payloads", () => {
    const data = normalizeRegistry(Array.from({ length: 20 }, (_, i) => raw(i + 1)));
    const writes = registryWrites(data.chains, data.rpcs, "ab".repeat(32)), batches = registryBatches(writes);
    expect(batches.flat().map((r) => r.id)).toEqual(writes.map((r) => r.id));
    expect(batches.every((b) => b.length <= 8)).toBe(true);
  });
});

describe("RPC classification and safe discovery", () => {
  it.each(["http://rpc.example", "wss://rpc.example", "https://localhost", "https://127.0.0.1", "https://169.254.169.254", "https://[::1]", "https://rpc.internal", "https://rpc.example:8545", "https://user:password@rpc.example", "https://rpc.example/${API_KEY}", "https://rpc.example?api_key=abc", "not a URL"])("does not execute %s", (endpoint) => expect(classifyEndpoint(endpoint).eligible).toBe(false));
  it.each(["10.1.1.1", "127.0.0.1", "192.168.1.1", "172.31.0.1", "100.64.0.1", "198.18.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"])("rejects nonpublic address %s", (address) => expect(publicAddress(address)).toBe(false));
  it("accepts public addresses and marks syntactic HTTPS eligibility separately from health", () => {
    expect(publicAddress("1.1.1.1")).toBe(true); expect(publicAddress("2606:4700::1111")).toBe(true);
    expect(classifyEndpoint("https://rpc.example")).toMatchObject({ eligible: true, reason: "public_https_unverified" });
  });
  it("refuses a public hostname that resolves to a private IP", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any);
    await expect(publicRpcRequest("https://rpc.example", {})).rejects.toThrow("non-public"); expect(request).not.toHaveBeenCalled();
  });
  it("queries the Arkiv view, verifies chain ID, pins DNS and returns entity provenance", async () => {
    vi.mocked(registryChain).mockResolvedValue(head() as any);
    const result = await resolveRegistryRpc(16602, { fresh: true });
    expect(result).toMatchObject({ chainId: 16602, endpoint: "https://rpc-one.example", source: "arkiv", rpcEntityKey: "0xrpc0", chainEntityKey: "0xchain", snapshot: "ab".repeat(32) });
    expect(mocks.lookups).toBe(1);
  });
  it("rejects wrong-chain responses and falls through to a second eligible candidate", async () => {
    const h = head(); h.rpcs.push({ ...h.rpcs[0], endpoint: "https://rpc-two.example", entityKey: "0xsecond" });
    mocks.responses.set("rpc-one.example", { id: 1, result: "0x1" }); vi.mocked(registryChain).mockResolvedValue(h as any);
    expect((await resolveRegistryRpc(16602, { fresh: true })).rpcEntityKey).toBe("0xsecond"); expect(request).toHaveBeenCalledTimes(2);
  });
  it("fails closed when Arkiv is unavailable, stale, inactive, or has no eligible endpoints", async () => {
    vi.mocked(registryChain).mockRejectedValueOnce(new Error("Arkiv offline")); await expect(resolveRegistryRpc(16602, { fresh: true })).rejects.toThrow("offline");
    for (const h of [{ ...head(), ageMs: 49 * 3600_000 }, { ...head(), chain: { ...head().chain, status: "deprecated" } }, { ...head(), rpcs: [] }]) { vi.mocked(registryChain).mockResolvedValue(h as any); await expect(resolveRegistryRpc(16602, { fresh: true })).rejects.toThrow(); }
    expect(request).not.toHaveBeenCalled();
  });
  it("never resolves local Anvil through the colliding public registry entry", async () => {
    expect(isLoopbackRpc("http://127.0.0.1:8545")).toBe(true);
    expect(await projectRpc(31337, "http://127.0.0.1:8545")).toMatchObject({ source: "local" });
    await expect(projectRpc(31337, "https://rpc.gochain.io")).rejects.toThrow("collides"); expect(registryChain).not.toHaveBeenCalled();
  });
  it("requires explicit env mode rather than silently falling back to a configured URL", async () => {
    vi.stubEnv("RPC_DISCOVERY", "env"); expect(await projectRpc(16602, "https://private-provider.example")).toEqual({ source: "env", endpoint: "https://private-provider.example" }); expect(registryChain).not.toHaveBeenCalled();
  });
});
