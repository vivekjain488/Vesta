import { describe, expect, it } from "vitest";
import { inspectRpc } from "../../../arkiv/src/rpc-inspect";
import type { RpcRecord } from "../../../arkiv/src/registry-data";
import { availabilityShade, hourBars, latencyShade, windowStats, type RpcSample } from "../../../frontend/lib/rpc-metrics";

const row = { chainId: 1, endpoint: "https://rpc.example", endpointHash: "a".repeat(64), uid: "a", host: "rpc.example", transport: "https", requiresKey: false, executionEligible: true, eligibilityReason: "public_https_unverified", sourceOrder: 0, sourcePath: "test" } satisfies RpcRecord;
const peer = { ...row, endpoint: "https://peer.example", endpointHash: "b".repeat(64), host: "peer.example", uid: "b" };

function respond(endpoint: string, body: unknown) {
  const method = Array.isArray(body) ? "batch" : (body as { method?: string }).method;
  if (method === "batch") return [{ jsonrpc: "2.0", id: 1, result: "0x1" }, { jsonrpc: "2.0", id: 2, result: "Geth/v1.13.0" }];
  if (method === "eth_chainId") return { jsonrpc: "2.0", id: 1, result: "0x1" };
  if (method === "eth_blockNumber") return { jsonrpc: "2.0", id: 1, result: endpoint.includes("peer") ? "0x20" : "0x1e" };
  if (method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id: 1, result: { timestamp: `0x${Math.floor(Date.now() / 1000 - 8).toString(16)}` } };
  if (method === "eth_getBalance") return { jsonrpc: "2.0", id: 1, result: "0x0" };
  throw new Error(`unexpected ${method}`);
}

describe("RPC inspection", () => {
  it("records chain, lag, head age, archive, batch, and TLS from read-only calls", async () => {
    const result = await inspectRpc(row, [peer], async (endpoint, body, _timeout, _status, onTls) => {
      onTls?.({ protocol: "TLSv1.3", authorized: true });
      return respond(endpoint, body);
    });
    expect(result.chainOk).toBe(true);
    expect(result.blockNumber).toBe("30");
    expect(result.lagBlocks).toBe(2);
    expect(result.peerCount).toBe(1);
    expect(result.headAgeSec).toBeGreaterThanOrEqual(7);
    expect(result.headAgeSec).toBeLessThanOrEqual(12);
    expect(result.archive).toBe("yes");
    expect(result.batch).toBe("yes");
    expect(result.clientVersion).toBe("Geth/v1.13.0");
    expect(result.tlsProtocol).toBe("TLSv1.3");
    expect(result.tlsOk).toBe(true);
    expect(result.blockLatencyMs).not.toBeNull();
  });

  it("marks a pruned node and a non-batch response without inventing a pass", async () => {
    const result = await inspectRpc(row, [], async (_endpoint, body) => {
      const method = Array.isArray(body) ? "batch" : (body as { method?: string }).method;
      if (method === "eth_chainId") return { jsonrpc: "2.0", id: 1, result: "0x2" };
      if (method === "eth_getBalance") return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "missing trie node" } };
      if (method === "batch") return { jsonrpc: "2.0", id: 1, result: "0x2" };
      if (method === "eth_blockNumber") return { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unavailable" } };
      return { jsonrpc: "2.0", id: 1, result: null };
    });
    expect(result.chainOk).toBe(false);
    expect(result.chainOutcome).toBe("wrong_chain");
    expect(result.archive).toBe("no");
    expect(result.batch).toBe("no");
    expect(result.blockLatencyMs).toBeNull();
    expect(result.lagBlocks).toBeNull();
  });
});

describe("health shades", () => {
  it("uses green, amber, and red bands and leaves empty hours blank", () => {
    expect(latencyShade(80).label).toBe("Fast");
    expect(latencyShade(240).label).toBe("Good");
    expect(latencyShade(700).label).toBe("Slow");
    expect(latencyShade(1400).band).toBe("bad");
    expect(latencyShade(40, false).label).toBe("Failed");
    expect(availabilityShade(99.9).band).toBe("good");
    expect(availabilityShade(96).band).toBe("warn");
    expect(availabilityShade(90).band).toBe("bad");
    const now = 1_700_000_000_000;
    const hour = 3600_000;
    const start = Math.floor(now / hour) * hour;
    const samples: RpcSample[] = [
      { at: start - hour, ok: true, latencyMs: 20 },
      { at: start - hour + 10, ok: false, latencyMs: 20, outcome: "timeout" },
      { at: start, ok: false, latencyMs: 20, outcome: "http_error" },
    ];
    const bars = hourBars(samples, now, 3);
    expect(bars.map((bar) => bar.count)).toEqual([0, 2, 1]);
    expect(bars[0].color).toBe("#e4e4e2");
    expect(bars[1].color).not.toBe(bars[2].color);
    const stats = windowStats(samples, 3 * hour, now);
    expect(stats.availability).toBe(33.33);
    expect(stats.successfulSamples).toBe(1);
  });
});
