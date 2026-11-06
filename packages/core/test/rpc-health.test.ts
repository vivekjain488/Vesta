import { describe, expect, it } from "vitest";
import { healthSummary, probeRpc } from "../../../arkiv/src/rpc-health";
import type { RpcRecord } from "../../../arkiv/src/registry-data";
const row = { chainId: 1, endpoint: "https://example.com", endpointHash: "a", uid: "a", host: "example.com", transport: "https", requiresKey: false, executionEligible: true, eligibilityReason: "public_https_unverified", sourceOrder: 0, sourcePath: "test" } satisfies RpcRecord;
describe("RPC health observations", () => {
  it("checks the requested chain and records provider rate headers", async () => {
    const result = await probeRpc(row, async (_url, body, _timeout, response) => { expect((body as any).method).toBe("eth_chainId"); response?.(200, { "ratelimit-limit": "10" }); return { jsonrpc: "2.0", id: 1, result: "0x1" }; });
    expect(result.ok).toBe(true); expect(result.headers["ratelimit-limit"]).toBe("10");
  });
  it("distinguishes wrong chains, malformed responses and throttling", async () => {
    expect((await probeRpc(row, async () => ({ jsonrpc: "2.0", id: 1, result: "0x2" }))).outcome).toBe("wrong_chain");
    expect((await probeRpc(row, async () => ({ result: "0x1" }))).outcome).toBe("invalid_response");
    expect((await probeRpc(row, async (_url, _body, _timeout, cb) => { cb?.(429, { "retry-after": "60" }); throw new Error("HTTP 429"); })).outcome).toBe("rate_limited");
  });
  it("calculates only sampled availability, excludes old samples and never invents a quota", () => {
    const now = 100000000, sample = (at: number, ok: boolean, latencyMs: number) => ({ at, ok, latencyMs, outcome: ok ? "healthy" : "timeout", headers: {} });
    const summary = healthSummary({ chainId: 1, endpointHash: "a", samples: [sample(now - 90000000, true, 10), sample(now - 1000, true, 20), sample(now, false, 7000)] }, now)!;
    expect(summary.sampledAvailabilityPercent).toBe(50); expect(summary.medianLatencyMs).toBe(20); expect(summary.sampleCount).toBe(2); expect(summary.samples).toHaveLength(2);
  });
});
