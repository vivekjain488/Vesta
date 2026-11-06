import { configHash, generateSignal, researchSetup, strategyKindForTemplate } from "@perpetua/core";
import type { Observation, RuntimeAgent, RuntimePorts, ToolCall } from "./types";
import type { RuntimeStore } from "./store";
import { strategyContext } from "./strategy-context";

export function assertObservation(o: Observation, kind: Observation["sourceKind"], now: number, maxAgeMs = 10000) {
  if (!o || o.sourceKind !== kind || !o.source || !Number.isSafeInteger(o.sourceAtMs) || !Number.isSafeInteger(o.receivedAtMs) || o.receivedAtMs > now + 1000 || o.sourceAtMs > now + 1000 || o.hash !== configHash(o.data)) throw new Error("Invalid observation source, timestamps or content hash");
  if (kind !== "arkiv_history" && now - Math.min(o.sourceAtMs, o.receivedAtMs) > maxAgeMs) throw new Error("live_data_stale");
}
export function observation<T>(sourceKind: Observation["sourceKind"], source: string, data: T, sourceAtMs: number, receivedAtMs: number, symbol?: string): Observation<T> {
  return { sourceKind, source, data, sourceAtMs, receivedAtMs, symbol, hash: configHash(data) };
}

/** Read tools take identity from the run, never from model arguments. */
export class RuntimeTools {
  constructor(private readonly a: RuntimeAgent, private readonly ports: RuntimePorts, private readonly store: RuntimeStore, private readonly now: () => number) {}
  async call(input: ToolCall, signal: AbortSignal): Promise<unknown> {
    if (!input || Object.keys(input).some((k) => !["tool", "symbol", "limit"].includes(k))) throw new Error("Unsupported tool arguments");
    signal.throwIfAborted();
    if (input.tool === "portfolio.current") {
      if (input.symbol !== undefined || input.limit !== undefined) throw new Error("Portfolio tool takes no arguments");
      const p = await this.ports.portfolio(this.store.portfolio(this.a.portfolioId)!, signal);
      if (p.owner.toLowerCase() !== this.a.owner || p.portfolioId !== this.a.portfolioId || !Number.isSafeInteger(p.sourceAtMs) || p.sourceAtMs > this.now() || this.now() - p.sourceAtMs > 10000 || !/^\d{1,30}$/.test(p.cashMicros) || !/^\d{1,30}$/.test(p.capacityMicros)) throw new Error("Invalid or stale portfolio state");
      return { ...p, pendingActions: this.store.actions(p.portfolioId).filter((a) => ["reserved", "submitting", "submitted", "unknown"].includes(a.state)) };
    }
    if (input.tool === "memory.search") {
      if (input.symbol && !this.a.config.symbols.includes(input.symbol)) throw new Error("Symbol is not authorized");
      const limit = input.limit ?? 5; if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Invalid history limit");
      const local = this.store.runs(this.a.id, 100).filter((r) => r.status !== "running" && (!input.symbol || r.decision?.symbol === input.symbol)).slice(0, limit).map(({ snapshot, ...run }) => run);
      const published = this.ports.episodes ? await this.ports.episodes(this.a, limit, signal) : [];
      return { local, published };
    }
    if (!input.symbol || !this.a.config.symbols.includes(input.symbol)) throw new Error("Symbol is not authorized");
    if (input.tool === "market.live") {
      if (input.limit !== undefined) throw new Error("Live tool does not accept a history limit");
      const o = await this.ports.live(input.symbol, this.a.config.market, signal); assertObservation(o, "live_feed", this.now());
      if (o.symbol !== input.symbol) throw new Error("Live instrument mismatch"); return o;
    }
    if (input.tool === "market.history") {
      const limit = input.limit ?? 240; if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error("Invalid candle limit");
      const o = await this.ports.history(input.symbol, limit, signal); assertObservation(o, "arkiv_history", this.now());
      if (o.symbol !== input.symbol || !o.data.entityKey || !Array.isArray(o.data.bars) || o.data.bars.length > limit || !o.data.bars.length) throw new Error("Invalid historical observations");
      for (let i = 0; i < o.data.bars.length; i++) {
        const b = o.data.bars[i];
        if (!Number.isSafeInteger(b.t) || b.t % 14400 || (b.t + 14400) * 1000 > this.now() || [b.o,b.h,b.l,b.c,b.v].some((n) => !Number.isFinite(n)) || Math.min(b.o,b.h,b.l,b.c) <= 0 || b.v < 0 || b.l > Math.min(b.o,b.c) || b.h < Math.max(b.o,b.c) || i > 0 && b.t - o.data.bars[i - 1].t !== 14400) throw new Error("Invalid closed candle history");
      }
      return o;
    }
    throw new Error("Unsupported tool");
  }
  /** Keep model context bounded; the complete observations are separately journaled. */
  context(value: any) {
    if (value?.sourceKind === "live_feed" && value.data?.minuteCandles) return { ...value, data: { ...value.data, strategyContext: strategyContext(this.a.config.template, value.data.minuteCandles.filter((bar: any) => Number(bar.t ?? bar.openTime) + 60000 <= this.now()), this.now()) } };
    if (value?.sourceKind !== "arkiv_history" || !value.data?.bars) return value;
    const bars = value.data.bars;
    let signal: unknown;
    const kind = strategyKindForTemplate(this.a.config.template);
    try { signal = generateSignal({ asset: value.symbol, bars }, { kind, ...this.a.config.parameters }); } catch { signal = { unavailable: "insufficient indicator history" }; }
    const setup = kind === "breakout" || kind === "bollinger" || kind === "rsi-recovery" ? researchSetup(kind, bars, this.a.config.parameters.breakoutBars, this.a.config.parameters.rsiOversold) : undefined;
    return { ...value, data: { ...value.data, bars: bars.slice(-8), totalBars: bars.length, fourHourEntryAnalysis: { scope: "4h entry analysis only; it is not an exit signal or a reason by itself to sell existing holdings", signal }, ...(setup ? { strategySetup: { ...setup, note: "Closed-bar setup evidence, not an order; apply current price and risk checks." } } : {}), coverageEndMs: (bars.at(-1).t + 14400) * 1000, gapToNowMs: this.now() - (bars.at(-1).t + 14400) * 1000 } };
  }
}
