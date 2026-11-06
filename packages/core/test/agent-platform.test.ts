import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { capitalModelPolicy, canonicalJson, configHash, futuresCandidate, preflightFutures, templateConfig, validateStrategyConfig, type AgentDefinition, type Bar, type ExecutionSnapshot, type FuturesCandidate, type PaperAccount } from "../src";
import { AgentDefinitions } from "../../../api/src/agent-definitions";
import { PaperHarness } from "../../../agent/src/harness";
import { AgentSupervisor } from "../../../agent/src/supervisor";
import { compileStrategy } from "../../../agent/src/strategy-compiler";
import type { Brain } from "../../../agent/src/zerog";
import { classify } from "../../../arkiv/src/import-atlas";

const owner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const config = () => templateConfig("perp-trend");
const definition = (): AgentDefinition => { const c = config(); return { id: "agent-1", owner: owner.address, name: "Trend", revision: 1, status: "paper", config: c, configHash: configHash(c), createdAt: 0, updatedAt: 0 }; };
const now = 4_000_000;
const candidate = (): FuturesCandidate => ({ symbol: "BTC", side: "long", observedAt: now - 30, candleAt: now - 15000, referencePrice: 100, stopPrice: 96, targetPrice: 112, atr: 2 });
const quote = (): ExecutionSnapshot => ({ symbol: "BTC", fetchedAt: now, sourceTimestamp: now - 1, bid: 99.99, ask: 100.01, mark: 100, availableNotionalUsd: 1000, roundTripCostBps: 20, liquidationPrice: 70, marketOpen: true, protectionAvailable: true });
const account = (): PaperAccount => ({ equityUsd: 1000, freeMarginUsd: 500, grossNotionalUsd: 0, marginUsedUsd: 0, dailyStartEquityUsd: 1000, dailyPnlUsd: 0, updatedAt: now });
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("strategy DSL and model routing", () => {
  it("validates every template and canonicalizes hashes independent of key order", () => {
    for (const id of ["spot-momentum", "spot-range", "spot-dca", "perp-trend", "perp-range"] as const) expect(validateStrategyConfig(templateConfig(id)).template).toBe(id);
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });
  it.each([
    (c: any) => { c.code = "execute()"; },
    (c: any) => { c.risk.maxLeverage = 20; },
    (c: any) => { c.risk.maxNotionalUsd = NaN; },
    (c: any) => { c.symbols = ["BTC", "BTC"]; },
    (c: any) => { c.execution.maxDecisionAgeSeconds = 10; },
    (c: any) => { c.parameters.targetAtr = 1.5; },
    (c: any) => { delete c.compute; },
  ])("rejects unsupported or invalid configuration %#", (mutate) => { const c = config(); mutate(c); expect(() => validateStrategyConfig(c)).toThrow(); });
  it("rejects short spot and spot leverage", () => {
    const c = templateConfig("spot-momentum"); c.direction = "short"; expect(() => validateStrategyConfig(c)).toThrow();
    c.direction = "long"; c.risk.maxLeverage = 2; expect(() => validateStrategyConfig(c)).toThrow();
  });
  it("uses cheap models for small allocations and premium only with capital plus runway", () => {
    expect(capitalModelPolicy(config(), 100, 20).model).toBe("small");
    expect(capitalModelPolicy(config(), 10000, 20).model).toBe("large");
    expect(capitalModelPolicy(config(), 10000, 3.5).model).toBe("small");
    expect(capitalModelPolicy(config(), 10000, 0).model).toBeNull();
    expect(capitalModelPolicy(config(), 1, 100).model).toBeNull();
  });
});

describe("owner isolation and signed mutations", () => {
  function store() { const dir = mkdtempSync(join(tmpdir(), "perpetua-config-")); temporary.push(dir); return new AgentDefinitions(dir, "http://localhost:8787"); }
  it("supports multiple agents per owner with independent IDs and revisions", () => {
    const s = store(); const payload = { name: "Same name", status: "draft", config: config() };
    const a = s.save(owner.address, payload); const b = s.save(owner.address, { ...payload, name: "Another agent" });
    expect(() => s.save(owner.address, { ...payload, name: " same NAME " })).toThrow("already exists");
    expect(s.save(other.address, payload).name).toBe("Same name");
    expect(a.id).not.toBe(b.id); expect(s.list(owner.address)).toHaveLength(2); expect(s.list(other.address)).toHaveLength(1);
    expect(() => s.save(other.address, { ...payload, revision: a.revision }, a.id)).toThrow("does not own");
    expect(s.save(owner.address, { ...payload, revision: a.revision }, a.id).revision).toBe(2);
    expect(() => s.save(owner.address, { ...payload, revision: a.revision }, a.id)).toThrow("reload");
    expect(() => s.get("../../sensitive")).toThrow();
  });
  it("authenticates exact payload and consumes nonces once, including concurrent replays", async () => {
    const s = store(); const payload = { name: "A", status: "paper", config: config() };
    const c = s.challenge(owner.address, "create", payload);
    const signature = await owner.signMessage({ message: c.message });
    const results = await Promise.allSettled([s.authorize(owner.address, "create", payload, c.nonce, signature), s.authorize(owner.address, "create", payload, c.nonce, signature)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const altered = s.challenge(owner.address, "create", payload);
    await expect(s.authorize(owner.address, "create", { ...payload, name: "B" }, altered.nonce, await owner.signMessage({ message: altered.message }))).rejects.toThrow();
  });
  it("rejects wrong owners, expired challenges, and live activation", async () => {
    const s = store(); const payload = { name: "A", status: "draft", config: config() };
    const c = s.challenge(owner.address, "create", payload);
    await expect(s.authorize(owner.address, "create", payload, c.nonce, await other.signMessage({ message: c.message }))).rejects.toThrow();
    const expired = s.challenge(owner.address, "create", payload, 0);
    await expect(s.authorize(owner.address, "create", payload, expired.nonce, "0x", 400000)).rejects.toThrow();
    expect(() => s.save(owner.address, { ...payload, status: "live" })).toThrow();
  });
});

describe("post-inference futures preflight", () => {
  it("sizes using stressed stop costs and allocated margin", () => {
    const result = preflightFutures(config(), candidate(), quote(), account(), now);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.modeledLossUsd).toBeLessThanOrEqual(2.5); expect(result.notionalUsd).toBeLessThanOrEqual(100); }
  });
  it.each([
    ["DECISION_STALE", (s: any, q: any, a: any) => { s.observedAt = now - 91; }],
    ["QUOTE_STALE", (s: any, q: any, a: any) => { q.sourceTimestamp = now - 10; }],
    ["QUOTE_STALE", (s: any, q: any, a: any) => { q.sourceTimestamp = now + 1; }],
    ["ACCOUNT_STALE", (s: any, q: any, a: any) => { a.updatedAt = now - 10; }],
    ["DAILY_LOSS_LIMIT", (s: any, q: any, a: any) => { a.dailyPnlUsd = -20; }],
    ["LIQUIDATION_BUFFER", (s: any, q: any, a: any) => { q.liquidationPrice = 95; }],
    ["PRICE_DRIFT", (s: any, q: any, a: any) => { q.bid = 101; q.ask = 101.01; q.mark = 101; }],
    ["PROTECTION_UNAVAILABLE", (s: any, q: any, a: any) => { q.protectionAvailable = false; }],
    ["INVALID_DATA", (s: any, q: any, a: any) => { a.marginUsedUsd = NaN; }],
    ["INVALID_DATA", (s: any, q: any, a: any) => { delete q.roundTripCostBps; }],
    ["PROTECTION_UNAVAILABLE", (s: any, q: any, a: any) => { q.protectionAvailable = "true"; }],
    ["NO_RISK_BUDGET", (s: any, q: any, a: any) => { a.grossNotionalUsd = 100; }],
    ["SIDE_NOT_ALLOWED", (s: any, q: any, a: any) => { s.side = "buy"; }],
  ] as const)("fails closed: %s", (reason, mutate) => {
    const s = candidate(), q = quote(), a = account(); mutate(s, q, a);
    expect(preflightFutures(config(), s, q, a, now)).toEqual({ ok: false, reason });
  });
  it("supports symmetric short sizing", () => {
    const s = { ...candidate(), side: "short" as const, stopPrice: 104, targetPrice: 88 };
    expect(preflightFutures(config(), s, { ...quote(), liquidationPrice: 130 }, account(), now).ok).toBe(true);
  });
});

function trendBars(): Bar[] {
  return Array.from({ length: 240 }, (_, i) => { const c = 50 + i * 0.2 + (i === 239 ? 2 : 0); return { t: now - (240 - i) * 14400, o: c - 0.1, h: c + 0.1, l: c - 0.2, c, v: 1000 }; });
}
describe("paper harness and scheduling", () => {
  it("excludes unfinished candles and rejects gaps", () => {
    const bars = trendBars(); expect(futuresCandidate(config(), "BTC", bars, now)).not.toBeNull();
    expect(futuresCandidate(config(), "BTC", [...bars, { ...bars[239], t: now, c: 1 }], now)).toEqual(futuresCandidate(config(), "BTC", bars, now));
    bars[100].t += 1; expect(futuresCandidate(config(), "BTC", bars, now)).toBeNull();
  });
  it("refreshes execution after reasoning and rejects delayed decisions", async () => {
    let clock = now;
    const events: any[] = [];
    const order: string[] = [];
    const d = definition(); d.config.symbols = ["BTC"]; d.configHash = configHash(d.config);
    const brain = { mode: "live", ledgerOg: async () => 100, think: async () => { order.push("think"); clock += 95; return { content: '{"actions":[{"tool":"evaluate"}]}', verified: true, chatId: "chat-1", costOg: 0.01 }; } } as unknown as Brain;
    const h = new PaperHarness(d, { market: async () => ({ bars: trendBars(), source: "test", fetchedAt: clock }), execution: async () => { order.push("quote"); return { ...quote(), fetchedAt: clock, sourceTimestamp: clock }; }, account: async () => ({ ...account(), updatedAt: clock }) }, (e) => events.push(e), brain, () => clock);
    await h.tick(); expect(order).toEqual(["think", "quote"]);
    expect(events.find((e) => e.type === "paper_preflight").data.verdict.reason).toBe("DECISION_STALE");
  });
  it("rejects arbitrary model tools", async () => {
    const d = definition(); d.config.symbols = ["BTC"]; d.configHash = configHash(d.config);
    const brain = { mode: "live", ledgerOg: async () => 100, think: async () => ({ content: '{"actions":[{"tool":"send_transaction"}]}', verified: true, costOg: 0.01 }) } as unknown as Brain;
    const h = new PaperHarness(d, { market: async () => ({ bars: trendBars(), source: "test", fetchedAt: now }), execution: async () => quote(), account: async () => account() }, () => {}, brain, () => now);
    await expect(h.tick()).rejects.toThrow("unsupported tool");
  });
  it("isolates agent IDs, prevents overlapping ticks and waits for cadence", async () => {
    let release!: () => void; let calls = 0;
    const s = new AgentSupervisor(async () => ({ tick: async () => { calls++; await new Promise<void>((r) => { release = r; }); } }), () => {});
    await s.reconcile([definition()]); const first = s.step(now); await s.step(now); expect(calls).toBe(1);
    release(); await first; await s.step(now + 1000); expect(calls).toBe(1);
    await s.stop(); expect(s.status()).toEqual([]);
  });
  it("keeps other agents running when one worker fails", async () => {
    const seen: string[] = []; const failures: string[] = [];
    const a = definition(), b = { ...definition(), id: "agent-2", owner: other.address };
    const s = new AgentSupervisor(async (d) => ({ tick: async () => { if (d.id === a.id) throw new Error("RPC offline"); seen.push(d.id); } }), (id) => failures.push(id));
    await s.reconcile([a, b]); await s.step(0);
    expect(seen).toEqual([b.id]); expect(failures).toEqual([a.id]);
    await s.stop();
  });
});

describe("natural-language compilation", () => {
  it("does not invent a strategy in simulation", async () => {
    await expect(compileStrategy({ mode: "sim" } as Brain, "Buy BTC cautiously")).rejects.toThrow("live 0G");
  });
  it("validates model output and preserves unsupported requirements for review", async () => {
    const brain = { mode: "live", think: async () => ({ verified: true, content: JSON.stringify({ config: config(), assumptions: ["4h closed candles"], unsupportedRequirements: ["Funding carry requires two legs"] }) }) } as unknown as Brain;
    const result = await compileStrategy(brain, "Trade funding carry and 4h trends"); expect(result.requiresClarification).toBe(true); expect(result.status).toBe("draft");
    const invalid = { ...config(), code: "trade()" };
    const badBrain = { mode: "live", think: async () => ({ verified: true, content: JSON.stringify({ config: invalid, assumptions: [], unsupportedRequirements: [] }) }) } as unknown as Brain;
    await expect(compileStrategy(badBrain, "Trade BTC with a custom program")).rejects.toThrow("unsupported field");
  });
});

describe("Signature Atlas evidence", () => {
  it("keeps collisions disputed even when a candidate decodes", () => {
    expect(classify({ sourcesAgreeing: 2, decodeVerified: 3, decodeFailed: 0, siblings: 2 })).toBe("disputed");
    expect(classify({ sourcesAgreeing: 1, decodeVerified: 1, decodeFailed: 0, siblings: 1 })).toBe("candidate");
    expect(classify({ sourcesAgreeing: 2, decodeVerified: 0, decodeFailed: 0, siblings: 1 })).toBe("candidate");
    expect(classify({ sourcesAgreeing: 2, decodeVerified: 1, decodeFailed: 0, siblings: 1 })).toBe("high");
  });
});
