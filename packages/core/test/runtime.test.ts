import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRiskProfile, configHash, normalizedAgentName, templateConfig } from "../src";
import { RuntimeStore } from "../../../agent/src/runtime/store";
import { MinuteHarness, parseTurn } from "../../../agent/src/runtime/run";
import { RuntimeService } from "../../../agent/src/runtime/service";
import { RuntimeTools, observation } from "../../../agent/src/runtime/tools";
import { AuditPublisher, type AuditPort } from "../../../agent/src/runtime/publisher";
import { liveMarketPort } from "../../../agent/src/runtime/ports";
import type { Brain, BrainResult, ChatMessage } from "../../../agent/src/zerog";
import { inferenceFromBrain, OpenRouterInference } from "../../../agent/src/inference";
import type { Decision, RuntimeAgent, RuntimePorts } from "../../../agent/src/runtime/types";

const owner = `0x${"11".repeat(20)}`, other = `0x${"22".repeat(20)}`;
const directories: string[] = [], stores: RuntimeStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
const hold = (summary = "No change; retain the existing strategy."): Decision => ({ decision: "hold", rationaleSummary: "No entry meets the configured conditions.", evidenceRefs: [], memorySummary: summary });
const buy = (): Decision => ({ ...hold(), decision: "buy", symbol: "BTC", notionalMicros: "80000000" });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "perpetua-runtime-")); directories.push(path);
  const file = join(path, "runtime.sqlite"); const store = new RuntimeStore(file); stores.push(store);
  let now = Math.floor(Date.now() / 60000) * 60000 + 1000;
  store.bindPortfolio({ id: "portfolio", owner, chainId: 31337, rpc: "http://127.0.0.1:8545", vault: owner, wallet: owner, riskGate: owner, stable: owner });
  const config = templateConfig("spot-momentum"); config.symbols = ["BTC"];
  const a = (id = "agent-1", mode: "analysis" | "execute" = "analysis") => store.activate({ id, owner, name: id, config, configHash: configHash(config), instructions: `Instructions for ${id}`, revision: 1, portfolioId: "portfolio", mode, status: "active" }, now);
  const messages: ChatMessage[][] = [];
  let answer = async (_m: ChatMessage[]): Promise<unknown> => ({ decision: hold() });
  const brain = { mode: "live", think: async (_policy: unknown, m: ChatMessage[]) => {
    const system = m[0].content;
    const research = system.includes("Act as technical market") ? { market: "Observed prices", portfolio: "Shared cash", unknowns: "News unavailable" } : system.includes("Act as independent bullish") ? { bull: "Potential upside", bear: "Potential downside", researchManager: "Assess both" } : undefined;
    if (!research) messages.push(structuredClone(m));
    return { content: JSON.stringify(research ?? await answer(m)), verified: true, chatId: `chat-${messages.length}`, model: "test-model", provider: "test-provider", tokens: 100, costOg: 0.01, tee: null };
  } } as unknown as Brain;
  const bars = Array.from({ length: 240 }, (_, i) => { const t = Math.floor(now / 14400000) * 14400 - (240 - i) * 14400; return { t, o: 100, h: 102, l: 99, c: 101, v: 50 }; });
  const ports: RuntimePorts = {
    inference: async () => inferenceFromBrain(brain),
    live: async (symbol) => observation("live_feed", "direct-test", { bid: 100, ask: 101 }, now, now, symbol),
    history: async (symbol, limit) => observation("arkiv_history", "arkiv-test", { bars: bars.slice(-limit), entityKey: "history-key" }, now - 14400000, now, symbol),
    portfolio: async () => ({ owner, portfolioId: "portfolio", sourceAtMs: now, cashMicros: "100000000", capacityMicros: "100000000", positions: [] }),
    executor: { authorizeActivation: async () => ({ ok: true }), validate: async () => ({ ok: true }), submit: async () => ({ state: "submitted", externalId: "order-1" }), reconcile: async () => ({ state: "filled", externalId: "order-1" }) },
  };
  const claim = (agent: RuntimeAgent) => store.claim(agent, Math.floor(now / 60000), now, now + 55000)!;
  return { store, file, a, ports, messages, brain, bars, claim, now: () => now, advance: (ms = 60000) => { now += ms; }, answer: (fn: typeof answer) => { answer = fn; } };
}

describe("durable hosted identities and scheduling", () => {
  it("normalizes wallet-scoped names and preserves original instructions", () => {
    const f = fixture(); const a = f.a();
    expect(normalizedAgentName(" Ａtlas   ONE ")).toBe("atlas one");
    expect(() => f.store.activate({ ...a, id: "different", name: " AGENT-1 " })).toThrow();
    expect(() => f.store.activate({ ...a, id: "other-owner", owner: other })).toThrow("another wallet");
    expect(f.store.agent(a.id)?.instructions).toContain(a.id);
  });
  it("claims each minute once across independent connections and recovers abandoned runs", () => {
    const f = fixture(), a = f.a(), first = f.claim(a);
    const second = new RuntimeStore(f.file); stores.push(second);
    expect(second.claim(a, first.slot, f.now(), f.now() + 55000)).toBeUndefined();
    f.advance();
    const next = second.claim(a, first.slot + 1, f.now(), f.now() + 55000)!;
    expect(next).toBeDefined(); expect(f.store.run(first.id)?.status).toBe("timed_out");
    expect(() => f.store.append(a, first, "late", {}, f.now())).toThrow("revoked");
  });
  it("calls AI every minute even without a new 4h candle, preserving memory across restarts", async () => {
    const f = fixture(), a = f.a();
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    expect(f.messages).toHaveLength(1); expect(f.store.memory(a.id).version).toBe(1);
    f.advance();
    const reopened = new RuntimeStore(f.file); stores.push(reopened);
    const run = reopened.claim(a, Math.floor(f.now() / 60000), f.now(), f.now() + 55000)!;
    await new MinuteHarness(reopened, f.ports, { now: f.now }).run(a, run);
    expect(f.messages).toHaveLength(2); expect(JSON.parse(f.messages[1][1].content).memory.lastRunId).not.toBe(run.id);
    expect(reopened.memory(a.id).version).toBe(2);
  });
  it("analyzes sibling agents concurrently with isolated instructions and memory", async () => {
    const f = fixture(); f.a("first"); f.a("second");
    const releases: (() => void)[] = [];
    f.answer(async () => { await new Promise<void>((resolve) => releases.push(resolve)); return { decision: hold() }; });
    const service = new RuntimeService(f.store, f.ports, { now: f.now, maxConcurrent: 2 });
    service.step(f.now()); await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases) release(); await service.drain();
    const identities = f.messages.map((m) => JSON.parse(m[1].content));
    expect(identities.map((x) => x.agentId).sort()).toEqual(["first", "second"]);
    expect(identities.every((x) => x.instructions === `Instructions for ${x.agentId}`)).toBe(true);
    service.step(f.now()); await service.drain(); expect(f.messages).toHaveLength(2);
  });
  it("records missed admission slots and downtime coverage without replaying old decisions", async () => {
    const f = fixture(), a = f.a(); const service = new RuntimeService(f.store, f.ports, { now: f.now });
    f.advance(51000); service.step(f.now());
    expect(f.store.runs(a.id)[0].status).toBe("skipped"); expect(f.messages).toHaveLength(0);
    f.advance(180000); service.step(f.now());
    expect(f.store.events(a.id).some((e) => e.kind === "schedule_gap")).toBe(true);
    await service.drain(); expect(f.messages).toHaveLength(0);
  });
});

describe("live state, historical context and bounded reasoning", () => {
  it("enforces different profile order limits without forcing a decision", () => {
    const f = fixture(), base = f.a();
    const cautious = { ...base, config: applyRiskProfile(base.config, "cautious") };
    const aggressive = { ...base, config: applyRiskProfile(base.config, "aggressive") };
    expect(cautious.config.parameters.minScore).toBeGreaterThan(aggressive.config.parameters.minScore);
    expect(() => parseTurn(JSON.stringify({ decision: buy() }), cautious)).toThrow("Invalid proposed size");
    expect(parseTurn(JSON.stringify({ decision: buy() }), aggressive).decision?.decision).toBe("buy");
    expect(parseTurn(JSON.stringify({ decision: hold() }), aggressive).decision?.decision).toBe("hold");
  });
  it("accepts a final decision accompanied by an empty tool list", async () => {
    const f = fixture(), a = f.a(); f.answer(async () => ({ tools: [], decision: hold() }));
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    expect(f.store.runs(a.id)[0].status).toBe("completed");
  });
  it("uses OpenRouter for analysis without 0G verification or execution authority", async () => {
    const f = fixture(), a = f.a();
    f.ports.inference = async () => new OpenRouterInference({ apiKey: "test", modelSmall: "test/model", maxTokensPerHour: 100000, maxTokensPerDay: 100000 }, (async (_url: unknown, init?: RequestInit) => { const system = JSON.parse(String(init?.body)).messages[0].content as string; const output = system.includes("Act as technical market") ? { market: "Observed prices", portfolio: "Shared cash", unknowns: "No news" } : system.includes("Act as independent bullish") ? { bull: "Upside", bear: "Downside", researchManager: "Consider both" } : { decision: buy() }; return new Response(JSON.stringify({ id: "or-1", choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }] })); }) as typeof fetch);
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    expect(f.store.runs(a.id)[0].status).toBe("completed"); expect(f.store.actions()).toHaveLength(0);
    expect(f.store.events(a.id).find((e) => e.kind === "inference_result")?.payload).toMatchObject({ backend: "openrouter", testingOnly: true, verified: null, costOg: null });
    const executionAgent = f.a("execute-agent", "execute");
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(executionAgent, f.claim(executionAgent));
    expect(f.store.runs(executionAgent.id)[0].error).toContain("testing_inference_cannot_execute");
  });
  it("journals the research stages and passes their reports to the final decision", async () => {
    const f = fixture(), a = f.a();
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    const reports = f.store.events(a.id).filter((e) => e.kind === "research_report");
    expect(reports.map((e) => (e.payload as any).stage).sort()).toEqual(["analysts", "debate"]);
    expect(f.messages[0].map((m) => m.content).join(" ")).toContain("researchManager");
    expect(f.store.runs(a.id)[0].status).toBe("completed");
  });
  it("fails closed on malformed research instead of making an action", async () => {
    const f = fixture(), a = f.a("agent-1", "execute");
    f.brain.think = async () => ({ content: '{"market":"unsupported"}', verified: true } as BrainResult);
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    expect(f.store.runs(a.id)[0].error).toBe("invalid_research_report");
    expect(f.store.actions()).toHaveLength(0);
  });
  it("feeds requested current observations back to the model before its final decision", async () => {
    const f = fixture(), a = f.a(); let turn = 0;
    f.answer(async () => ++turn === 1 ? { tools: [{ tool: "market.live", symbol: "BTC" }] } : { decision: hold("Remember the refreshed quote.") });
    const live = vi.spyOn(f.ports, "live");
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    expect(live).toHaveBeenCalledTimes(2); expect(f.messages).toHaveLength(2);
    expect(f.messages[1].at(-1)?.content).toContain("direct-test");
    expect(f.store.memory(a.id).summary).toBe("Remember the refreshed quote.");
  });
  it("allows older Arkiv history but refuses it as a current observation", async () => {
    const f = fixture(), a = f.a(), tools = new RuntimeTools(a, f.ports, f.store, f.now);
    await expect(tools.call({ tool: "market.history", symbol: "BTC" }, new AbortController().signal)).resolves.toMatchObject({ sourceKind: "arkiv_history" });
    f.ports.live = async () => observation("arkiv_history", "mirror", { price: 100 }, f.now(), f.now(), "BTC");
    await expect(tools.call({ tool: "market.live", symbol: "BTC" }, new AbortController().signal)).rejects.toThrow("source");
  });
  it("records missing live data, still calls AI, and blocks a proposed trade", async () => {
    const f = fixture(), a = f.a("agent-1", "execute"); f.answer(async () => ({ decision: buy() }));
    f.ports.live = async () => { throw new Error("live_data_unavailable"); };
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    expect(f.messages).toHaveLength(1); expect(f.store.actions()).toHaveLength(0);
    expect(f.store.events(a.id).some((e) => e.kind === "action_rejected" && JSON.stringify(e.payload).includes("required_observation_unavailable"))).toBe(true);
  });
  it("rejects a proposal when research latency makes its live quote stale", async () => {
    const f = fixture(), a = f.a("agent-1", "execute");
    f.answer(async () => { f.advance(11000); return { decision: buy() }; });
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    expect(f.store.actions()).toHaveLength(0);
    expect(f.store.events(a.id).some((e) => e.kind === "action_rejected" && JSON.stringify(e.payload).includes("decision_quote_stale"))).toBe(true);
  });
  it("rejects stale direct feeds, unfinished history and cross-scope tool arguments", async () => {
    const f = fixture(), a = f.a(), t = new RuntimeTools(a, f.ports, f.store, f.now), abort = new AbortController().signal;
    f.ports.live = async () => observation("live_feed", "direct", {}, f.now() - 11000, f.now(), "BTC");
    await expect(t.call({ tool: "market.live", symbol: "BTC" }, abort)).rejects.toThrow("stale");
    await expect(t.call({ tool: "market.live", symbol: "ETH" }, abort)).rejects.toThrow("authorized");
    await expect(t.call({ tool: "memory.search", owner: other } as any, abort)).rejects.toThrow("arguments");
    f.ports.history = async () => observation("arkiv_history", "arkiv", { bars: [{ ...f.bars[0], t: Math.floor(f.now() / 14400000) * 14400 }], entityKey: "x" }, f.now(), f.now(), "BTC");
    await expect(t.call({ tool: "market.history", symbol: "BTC" }, abort)).rejects.toThrow("closed candle");
  });
  it("rejects unsupported tools, unverified responses and invented evidence", async () => {
    for (const output of [{ tools: [{ tool: "send_transaction" }] }, { decision: { ...hold(), evidenceRefs: ["invented"] } }]) {
      const f = fixture(), a = f.a(); f.answer(async () => output);
      await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
      expect(f.store.runs(a.id)[0].status).toBe("error"); expect(f.store.actions()).toHaveLength(0);
    }
    const f = fixture(), a = f.a(); f.brain.think = async () => ({ content: JSON.stringify({ decision: buy() }), verified: false } as BrainResult);
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    expect(f.store.runs(a.id)[0].error).toBe("unverified_or_missing_inference");
  });
  it("keeps token reservations durable and shared across sibling agents", async () => {
    const f = fixture(), a = f.a("first"), b = f.a("second");
    expect(f.store.reserveTokens(a, 60, 100, 100, 1000, f.now())).toBe(true);
    const reopened = new RuntimeStore(f.file); stores.push(reopened);
    expect(reopened.reserveTokens(b, 60, 100, 100, 1000, f.now())).toBe(false);
    expect(reopened.reserveTokens(a, 50, 100, 100, 1000, f.now())).toBe(false);
  });
  it("records a budget-blocked minute without pretending an AI call succeeded", async () => {
    const f = fixture(), a = f.a();
    await new MinuteHarness(f.store, f.ports, { now: f.now, agentDailyTokens: 1 }).run(a, f.claim(a));
    expect(f.messages).toHaveLength(0); expect(f.store.runs(a.id)[0].error).toBe("inference_budget_exhausted");
    expect(f.store.events(a.id).find((e) => e.kind === "decision")?.payload).toMatchObject({ source: "runtime", decision: "hold" });
  });
  it("does not commit a late inference after pause and resume of the same revision", async () => {
    const f = fixture(), a = f.a(); let release!: () => void;
    f.answer(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { decision: buy() }; });
    const run = f.claim(a), work = new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, run);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.store.pause(a.id, owner, f.now()); const resumed = f.store.activate(a, f.now() + 1);
    expect(resumed.generation).not.toBe(a.generation); release(); await work;
    expect(f.store.run(run.id)?.status).toBe("error"); expect(f.store.memory(a.id).version).toBe(0); expect(f.store.actions()).toHaveLength(0);
  });
  it("propagates the run deadline to inference and journals the timeout", async () => {
    const f = fixture(), a = f.a(); let cancelled = false;
    f.brain.think = async (_policy, _messages, _tokens, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => { cancelled = true; reject(signal!.reason); }, { once: true });
    });
    const start = Date.now(), run = f.store.claim(a, Math.floor(start / 60000), start, start + 100)!;
    await new MinuteHarness(f.store, f.ports).run(a, run);
    expect(cancelled).toBe(true); expect(f.store.run(run.id)?.status).toBe("timed_out");
  });
  it("coalesces concurrent live reads while a later request fetches again", async () => {
    const now = Date.now(); let release!: () => void;
    const send = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return new Response(JSON.stringify({ symbol: "BTCUSDT", bidPrice: "100", askPrice: "101", lastPrice: "100.5", closeTime: now })); });
    const live = liveMarketPort(send as typeof fetch, () => now), signal = new AbortController().signal;
    const a = live("BTC", "spot", signal), b = live("BTC", "spot", signal); release();
    await Promise.all([a,b]); expect(send).toHaveBeenCalledTimes(1);
    const c = live("BTC", "spot", signal); release(); await c; expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("shared capital and execution recovery", () => {
  it("replaces unconfirmed model fill claims with the actual paper settlement", async () => {
    const f = fixture(), a = f.a();
    f.answer(async () => ({ decision: { ...buy(), memorySummary: "Sold everything and earned profit" } }));
    const run = f.claim(a); await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, run);
    expect(f.store.memory(a.id).summary).toContain("not yet confirmed");
    f.store.recordPaperOutcome(a, run.id, { decision: "buy", outcome: "rejected", reason: "insufficient virtual cash", cash: 10, btc: 0 }, f.now());
    expect(f.store.memory(a.id).summary).toContain("rejected");
    expect(f.store.memory(a.id).summary).not.toContain("earned profit");
    expect(f.store.events(a.id).some((e) => e.kind === "paper_settlement")).toBe(true);
  });
  it("never reserves the same wallet capacity twice across parallel agents", async () => {
    const f = fixture(), a = f.a("first", "execute"), b = f.a("second", "execute");
    f.answer(async () => ({ decision: buy() }));
    await Promise.all([new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a)), new MinuteHarness(f.store, f.ports, { now: f.now }).run(b, f.claim(b))]);
    expect(f.store.actions()).toHaveLength(1); expect(f.store.actions()[0].reservationMicros).toBe("80000000");
    expect([...f.store.events(a.id), ...f.store.events(b.id)].some((e) => JSON.stringify(e.payload).includes("wallet_budget_exhausted"))).toBe(true);
  });
  it("waits for Arkiv intent publication, then reconciles uncertain submissions without resending", async () => {
    const f = fixture(), a = f.a("first", "execute"); f.answer(async () => ({ decision: buy() }));
    const submit = vi.spyOn(f.ports.executor!, "submit").mockRejectedValue(new Error("timeout"));
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    const service = new RuntimeService(f.store, f.ports); await service.executePending(); expect(submit).not.toHaveBeenCalled();
    for (const e of f.store.pending(100)) f.store.acknowledge(e.id, `key:${e.id}`);
    await service.executePending(); expect(submit).toHaveBeenCalledTimes(1); expect(f.store.actions()[0].state).toBe("unknown");
    await service.executePending(); expect(submit).toHaveBeenCalledTimes(1); expect(f.store.actions()[0].state).toBe("filled");
  });
  it("invalidates a reserved proposal when an agent pauses and resumes", async () => {
    const f = fixture(), a = f.a("first", "execute"); f.answer(async () => ({ decision: buy() }));
    const submit = vi.spyOn(f.ports.executor!, "submit");
    await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    f.store.pause(a.id, owner); f.store.activate(a);
    await new RuntimeService(f.store, f.ports).executePending();
    expect(submit).not.toHaveBeenCalled(); expect(f.store.actions()[0].state).toBe("rejected");
  });
});

describe("durable Arkiv outbox", () => {
  it("batches durable events while preserving their logical identities", async () => {
    const f = fixture(), a = f.a(); await new MinuteHarness(f.store, f.ports, { now: f.now }).run(a, f.claim(a));
    const existing = new Map<string, string>(); const send = vi.fn(async () => "hash");
    const sendBatch = vi.fn(async (events: any[]) => { for (const e of events) existing.set(e.id, `key:${e.id}`); return "batch-hash"; });
    const port: AuditPort = { owner, find: async (id) => existing.get(id), send, sendBatch, confirm: async () => {} };
    await new AuditPublisher(f.store, port).flush(100);
    expect(send).not.toHaveBeenCalled(); expect(sendBatch.mock.calls.every(([events]) => events.length <= 5)).toBe(true);
    expect(f.store.pending()).toHaveLength(0); expect(existing.size).toBe(f.store.events(a.id).length);
  });
  it("publishes each event and recovers a lost acknowledgement by querying its logical identity", async () => {
    const f = fixture(), a = f.a(); const existing = new Map<string, string>(); let sends = 0;
    const port: AuditPort = { owner, find: async (id) => existing.get(id), send: async (event) => { sends++; existing.set(event.id, `key:${event.id}`); throw new Error("lost acknowledgement"); }, confirm: async () => {} };
    const publisher = new AuditPublisher(f.store, port);
    await expect(publisher.flush()).rejects.toThrow("lost acknowledgement");
    const reopened = new RuntimeStore(f.file); stores.push(reopened);
    await new AuditPublisher(reopened, port).flush();
    expect(sends).toBe(1); expect(reopened.pending()).toHaveLength(0); expect(f.store.publicationStatus(a.id)).toMatchObject({ total: 1, confirmed: 1 });
  });
  it("never blindly resubmits an unknown publication when the writer outcome is unavailable", async () => {
    const f = fixture(); f.a(); const send = vi.fn(async () => { throw new Error("unknown RPC failure"); });
    const port: AuditPort = { owner, find: async () => undefined, send, confirm: async () => {} };
    await expect(new AuditPublisher(f.store, port).flush()).rejects.toThrow();
    await expect(new AuditPublisher(f.store, port).flush()).rejects.toThrow("uncertain");
    expect(send).toHaveBeenCalledTimes(1); expect(f.store.pending()).toHaveLength(1);
  });
});
