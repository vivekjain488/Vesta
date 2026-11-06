/**
 * Deeper read-only inspection for one registry RPC. No transactions, no caller-supplied URLs.
 * The cheap monitor probe stays on eth_chainId; this runs only when someone opens an endpoint.
 */
import type { RpcRecord } from "./registry-data";
import { probeRpc } from "./rpc-health";
import { publicRpcRequest, type TlsNote } from "./registry-resolver";

export type RpcInspection = {
  at: number;
  vantage: string;
  chainOk: boolean | null;
  chainOutcome: string;
  probeLatencyMs: number | null;
  blockLatencyMs: number | null;
  blockNumber: string | null;
  peerMaxBlock: string | null;
  peerCount: number;
  lagBlocks: number | null;
  headAgeSec: number | null;
  archive: "yes" | "no" | "unknown";
  batch: "yes" | "no" | "unknown";
  clientVersion: string | null;
  tlsProtocol: string | null;
  tlsOk: boolean | null;
  httpStatus?: number;
};

type RpcCall = typeof publicRpcRequest;

const callBody = (method: string, params: unknown[] = [], id = 1) => ({ jsonrpc: "2.0", id, method, params });

function hexQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function cleanText(value: unknown, max = 96) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[^\x20-\x7E]/g, "").trim().slice(0, max);
  return text || null;
}

function lagOf(mine: bigint | null, peers: bigint[]) {
  if (mine === null || !peers.length) return { peerMaxBlock: null as string | null, lagBlocks: null as number | null };
  const max = peers.reduce((best, n) => (n > best ? n : best), mine);
  const lag = max - mine;
  return { peerMaxBlock: max.toString(), lagBlocks: lag <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(lag) : null };
}

async function timed(request: RpcCall, endpoint: string, body: unknown, timeoutMs: number, onResponse?: (status: number, headers: Record<string, string>) => void, onTls?: (tls: TlsNote) => void) {
  const start = performance.now();
  try {
    const result = await request(endpoint, body, timeoutMs, onResponse, onTls);
    return { result, latencyMs: Math.round(performance.now() - start), error: null as string | null };
  } catch (e) {
    return { result: null, latencyMs: Math.round(performance.now() - start), error: String((e as Error).message).replace(/https?:\/\/\S+/g, "[endpoint]").slice(0, 160) };
  }
}

/** Measure one verified registry row. `peers` are other eligible rows used only for block-height comparison. */
export async function inspectRpc(row: RpcRecord, peers: RpcRecord[] = [], request: RpcCall = publicRpcRequest, vantage = process.env.RPC_HEALTH_VANTAGE ?? "This API host"): Promise<RpcInspection> {
  const tlsBox: { current: TlsNote | null } = { current: null };
  const statusBox: { current?: number } = {};
  const [probe, blockCall, headCall, archiveCall, batchCall] = await Promise.all([
    probeRpc(row, request),
    timed(request, row.endpoint, callBody("eth_blockNumber"), 7000, (status) => { if (statusBox.current === undefined) statusBox.current = status; }, (info) => { tlsBox.current = info; }),
    timed(request, row.endpoint, callBody("eth_getBlockByNumber", ["latest", false]), 7000),
    timed(request, row.endpoint, callBody("eth_getBalance", ["0x0000000000000000000000000000000000000000", "0x1"]), 7000),
    timed(request, row.endpoint, [callBody("eth_chainId", [], 1), callBody("web3_clientVersion", [], 2)], 7000),
  ]);

  const blockNumber = hexQuantity(blockCall.result?.result);
  const peerBlocks: bigint[] = [];
  if (blockNumber !== null) {
    const unique = peers.filter((peer) => peer.endpoint !== row.endpoint && peer.executionEligible && !peer.requiresKey).slice(0, 3);
    const heights = await Promise.all(unique.map(async (peer) => timed(request, peer.endpoint, callBody("eth_blockNumber"), 4000)));
    for (const height of heights) {
      const value = hexQuantity(height.result?.result);
      if (value !== null) peerBlocks.push(value);
    }
  }
  const compared = lagOf(blockNumber, peerBlocks);

  let headAgeSec: number | null = null;
  const timestamp = hexQuantity(headCall.result?.result?.timestamp);
  if (timestamp !== null && timestamp <= BigInt(Number.MAX_SAFE_INTEGER)) {
    headAgeSec = Math.max(0, Math.round(Date.now() / 1000 - Number(timestamp)));
  }

  let archive: RpcInspection["archive"] = "unknown";
  if (hexQuantity(archiveCall.result?.result) !== null) archive = "yes";
  else if (archiveCall.result?.error) {
    const message = String(archiveCall.result.error.message ?? "");
    archive = /historical|archive|pruned|missing trie|old block|not available|header not found|unknown block/i.test(message) ? "no" : "unknown";
  }

  const batchItems = Array.isArray(batchCall.result) ? batchCall.result : null;
  const chainItem = batchItems?.find((item) => item?.id === 1);
  const versionItem = batchItems?.find((item) => item?.id === 2);
  const batch: RpcInspection["batch"] = chainItem?.result !== undefined && versionItem?.result !== undefined ? "yes" : batchCall.result ? "no" : "unknown";

  return {
    at: Date.now(),
    vantage,
    chainOk: probe.outcome === "healthy" ? true : probe.outcome === "wrong_chain" ? false : null,
    chainOutcome: probe.outcome,
    probeLatencyMs: probe.latencyMs,
    blockLatencyMs: blockNumber !== null ? blockCall.latencyMs : null,
    blockNumber: blockNumber?.toString() ?? null,
    peerMaxBlock: compared.peerMaxBlock,
    peerCount: peerBlocks.length,
    lagBlocks: compared.lagBlocks,
    headAgeSec,
    archive,
    batch,
    clientVersion: cleanText(versionItem?.result),
    tlsProtocol: tlsBox.current?.protocol ?? null,
    tlsOk: tlsBox.current ? tlsBox.current.authorized : null,
    httpStatus: probe.httpStatus ?? statusBox.current,
  };
}
