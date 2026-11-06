import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@perpetua/arkiv", () => ({ registryRpcs: vi.fn() }));
vi.mock("../../../arkiv/src/rpc-health", () => ({ probeRpc: vi.fn(async () => ({ at: 123, ok: true, latencyMs: 10, outcome: "healthy", headers: {} })) }));
import { registryRpcs } from "@perpetua/arkiv";
import { probeRpc } from "../../../arkiv/src/rpc-health";
import { checkSelectedRpcs, validateRpcHashes } from "../../../api/src/rpc-check";
const hash = "a".repeat(64), second = "b".repeat(64), snapshot = "f".repeat(64);
const rpc = (endpointHash: string, extra = {}) => ({ chainId: 5, endpointHash, uid: endpointHash, host: `${endpointHash[0]}.example`, endpoint: `https://${endpointHash[0]}.example`, executionEligible: true, requiresKey: false, transport: "https", eligibilityReason: "public_https_unverified", ...extra });
describe("on-demand RPC checks", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("rejects arbitrary URLs, excessive selections and duplicates", () => {
    expect(() => validateRpcHashes(["https://internal"])).toThrow();
    expect(() => validateRpcHashes(Array(11).fill(hash))).toThrow();
    expect(() => validateRpcHashes([hash, hash])).toThrow();
  });
  it("only checks endpoint hashes present in the requested Arkiv snapshot", async () => {
    vi.mocked(registryRpcs).mockResolvedValue({ rows: [rpc(hash)], nextAfter: null } as any);
    await expect(checkSelectedRpcs(5, snapshot, [second])).rejects.toThrow("not in this chain");
    expect(probeRpc).not.toHaveBeenCalled();
  });
  it("returns independent outcomes and labels key-only endpoints without probing them", async () => {
    vi.mocked(registryRpcs).mockResolvedValue({ rows: [rpc(hash), rpc(second, { requiresKey: true, executionEligible: false })], nextAfter: null } as any);
    const result = await checkSelectedRpcs(5, snapshot, [hash, second]);
    expect(result.results[hash].sample?.outcome).toBe("healthy"); expect(result.results[second].message).toMatch(/required/i);
    expect(probeRpc).toHaveBeenCalledTimes(1);
  });
});
