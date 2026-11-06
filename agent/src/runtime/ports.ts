import { marketCandles, projectTransport, runtimeHistory } from "@perpetua/arkiv";
import { erc20Abi, createPublicClient, type Address } from "viem";
import { perpetuaVaultAbi, riskGateAbi } from "@perpetua/core";
import { collectSnapshot } from "../../../arkiv/src/market-data";
import { observation } from "./tools";
import { createInference, type InferenceProvider, type InferenceOptions } from "../inference";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Observation, PortfolioBinding, RuntimeAgent, RuntimePorts } from "./types";

/** Coalesce only concurrent direct reads, never cache old observations as current. */
export function liveMarketPort(send: typeof fetch = fetch, now = Date.now) {
  const inFlight = new Map<string, Promise<Observation>>();
  return async (symbol: string, market: "spot" | "perpetual", abort: AbortSignal) => {
    const key = `${market}:${symbol}`;
    if (!inFlight.has(key)) {
      const work = (async () => {
        if (market === "perpetual") {
          const s = await collectSnapshot(`${symbol}USDT`);
          return observation("live_feed", "binance-usdm", { marketType: market, markPrice: s.markPrice, indexPrice: s.indexPrice, fundingRate: s.fundingRate, openInterest: s.openInterest, bid: s.book.bids[0], ask: s.book.asks[0], bookAtMs: s.book.atMs, openInterestAtMs: s.openInterestAtMs }, Math.min(s.sourceAtMs, s.book.atMs, s.openInterestAtMs), now(), symbol);
        }
        const r = await send(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${encodeURIComponent(`${symbol}USDT`)}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`Live spot feed HTTP ${r.status}`);
        const data: any = await r.json();
        if (data.symbol !== `${symbol}USDT` || !Number.isSafeInteger(data.closeTime) || ![data.bidPrice, data.askPrice, data.lastPrice].every((x) => Number.isFinite(Number(x)) && Number(x) > 0) || Number(data.bidPrice) >= Number(data.askPrice)) throw new Error("Invalid live spot quote");
        return observation("live_feed", "binance-spot", { marketType: market, bid: data.bidPrice, ask: data.askPrice, lastPrice: data.lastPrice, quoteCurrency: "USDT", timestampKind: "ticker_window_close" }, data.closeTime, now(), symbol);
      })();
      inFlight.set(key, work); void work.finally(() => inFlight.delete(key)).catch(() => {});
    }
    const result = await inFlight.get(key)!; abort.throwIfAborted(); return result;
  };
}

export async function currentPortfolio(p: PortfolioBinding, abort: AbortSignal) {
  const pub = createPublicClient({ transport: projectTransport(p.chainId, p.rpc) });
  if (await pub.getChainId() !== p.chainId) throw new Error("Portfolio chain ID mismatch");
  const block = await pub.getBlock(); const blockNumber = block.number;
  const [owner, walletCash, vaultCash, mandate, count, nav, hibernating, withdrawalPaused, tradingOff] = await Promise.all([
    pub.readContract({ address: p.vault as Address, abi: perpetuaVaultAbi, functionName: "agentOwner", blockNumber }),
    pub.readContract({ address: p.stable as Address, abi: erc20Abi, functionName: "balanceOf", args: [p.wallet as Address], blockNumber }),
    pub.readContract({ address: p.stable as Address, abi: erc20Abi, functionName: "balanceOf", args: [p.vault as Address], blockNumber }),
    pub.readContract({ address: p.riskGate as Address, abi: riskGateAbi, functionName: "mandate", blockNumber }),
    pub.readContract({ address: p.riskGate as Address, abi: riskGateAbi, functionName: "assetCount", blockNumber }),
    pub.readContract({ address: p.vault as Address, abi: perpetuaVaultAbi, functionName: "totalAssets", blockNumber }),
    pub.readContract({ address: p.riskGate as Address, abi: riskGateAbi, functionName: "hibernating", blockNumber }),
    pub.readContract({ address: p.riskGate as Address, abi: riskGateAbi, functionName: "withdrawalPaused", blockNumber }),
    pub.readContract({ address: p.riskGate as Address, abi: riskGateAbi, functionName: "tradingOff", blockNumber }),
  ]);
  abort.throwIfAborted();
  if (owner.toLowerCase() !== p.owner.toLowerCase()) throw new Error("Portfolio ownership changed");
  const m = mandate as readonly bigint[];
  const capacity = !hibernating && !withdrawalPaused && !tradingOff && m[2] >= block.timestamp && m[6] > m[7] ? m[6] - m[7] : 0n;
  if (count > 64n) throw new Error("Portfolio asset count exceeds the bounded adapter limit");
  const positions = await Promise.all(Array.from({ length: Number(count) }, async (_, i) => {
    const token = await pub.readContract({ address: p.riskGate as Address, abi: riskGateAbi, functionName: "assetList", args: [BigInt(i)], blockNumber });
    const quantity = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [p.wallet as Address], blockNumber });
    if (quantity === 0n) return null;
    const [symbol, decimals] = await Promise.all([pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol", blockNumber }), pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber })]);
    return { token, symbol, decimals, quantityAtomic: String(quantity), attribution: "shared_portfolio; per-agent lots require the execution adapter" };
  }));
  abort.throwIfAborted();
  return { portfolioId: p.id, owner: p.owner, sourceKind: "chain_read", source: `chain:${p.chainId}`, sourceAtMs: Date.now(), cashMicros: String(walletCash + vaultCash), capacityMicros: String(capacity), navMicros: String(nav), blockNumber: String(blockNumber), positions: positions.filter((position) => position !== null), risk: { aggregateRiskyValueMicros: String(m[7]), mandateEpoch: String(m[0]), mandateValidUntil: String(m[2]), hibernating, withdrawalPaused, tradingOff, blockAtMs: Number(block.timestamp) * 1000 } };
}

export function defaultPorts(inferenceOptions: InferenceOptions = {}): RuntimePorts {
  const providers = new Map<string, { fingerprint: string; promise: Promise<InferenceProvider> }>();
  const portfolios = new Map<string, ReturnType<typeof currentPortfolio>>();
  return {
    live: liveMarketPort(),
    history: async (symbol, limit, abort) => {
      const s = await marketCandles(`${symbol}USDT`, limit, undefined, { requireLatest: false }); abort.throwIfAborted();
      return observation("arkiv_history", "binance-usdm-via-arkiv", { bars: s.bars, entityKey: String(s.entityKey), marketType: "perpetual", quoteCurrency: "USDT" }, s.lastClosedAtMs, Date.now(), symbol);
    },
    portfolio: async (p, abort) => {
      if (!portfolios.has(p.id)) {
        const work = currentPortfolio(p, AbortSignal.timeout(10000)); portfolios.set(p.id, work);
        void work.finally(() => portfolios.delete(p.id)).catch(() => {});
      }
      const state = await portfolios.get(p.id)!; abort.throwIfAborted(); return state;
    },
    episodes: async (a, limit, abort) => {
      const writer = process.env.ARKIV_RUNTIME_WRITER_ADDRESS as Address | undefined;
      if (!writer) throw new Error("Runtime history writer is not configured");
      const rows = await runtimeHistory(a.owner, a.id, writer, 100); abort.throwIfAborted();
      return rows.filter((r) => r.event.owner.toLowerCase() === a.owner && r.event.agentId === a.id && ["decision", "memory_checkpoint", "action_filled", "action_rejected"].includes(r.event.kind)).slice(0, limit).map((r) => {
        const payload = r.event.payload as Record<string, unknown>;
        return { entityKey: r.entityKey, eventId: r.event.id, atMs: r.event.atMs, kind: r.event.kind,
          decision: payload.decision, rationaleSummary: String(payload.rationaleSummary ?? payload.reason ?? "").slice(0, 1000), summary: String(payload.summary ?? "").slice(0, 1000) };
      });
    },
    inference: async (a: RuntimeAgent) => {
      const fingerprint = `${a.id}:${a.revision}`;
      if (providers.get(a.id)?.fingerprint !== fingerprint) {
        const promise = createInference(inferenceOptions);
        providers.set(a.id, { fingerprint, promise }); void promise.catch(() => { if (providers.get(a.id)?.promise === promise) providers.delete(a.id); });
      }
      return providers.get(a.id)!.promise;
    },
  };
}

export async function loadRuntimePorts(options: InferenceOptions = {}): Promise<RuntimePorts> {
  const defaults = defaultPorts(options);
  if (!process.env.HOSTED_RUNTIME_ADAPTER_MODULE) return defaults;
  const adapter = await import(pathToFileURL(resolve(process.env.HOSTED_RUNTIME_ADAPTER_MODULE)).href);
  if (typeof adapter.createRuntimePorts !== "function") throw new Error("Runtime adapter must export createRuntimePorts(defaults)");
  const ports = { ...defaults, ...await adapter.createRuntimePorts(defaults) } as RuntimePorts;
  if (ports.executor && ["authorizeActivation", "validate", "submit", "reconcile"].some((k) => typeof (ports.executor as any)[k] !== "function")) throw new Error("Execution adapter must support activation, fresh validation, submission and reconciliation");
  return ports;
}
