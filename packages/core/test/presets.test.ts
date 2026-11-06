import { describe, expect, it } from "vitest";
import { verifyMessage } from "viem";
import {
  AGENT_PRESETS, computeFeatureSeries, decideSignal, generateSignal, presetConfig, signalFeatures, simulate, templateKind, tierFor, TIER_PROFILES,
  validateStrategyConfig, type Bar, type BacktestParams, type SignalFeatures,
} from "../src";
import { FallbackBrain, FireworksBrain, FIREWORKS_DEFAULT_MODEL, FIREWORKS_MODELS } from "../../../agent/src/fallback-brain";
import { parseSentiment } from "../../../agent/src/prompts";
import { RulesAttester, LOCAL_RULES_SIGNER_KEY } from "../../../agent/src/rules-attestation";
import { compileStrategy } from "../../../agent/src/strategy-compiler";
import type { Brain } from "../../../agent/src/zerog";

function synthBars(n: number, drift: number, seed = 1, start = 100): Bar[] {
  let x = seed;
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647) - 0.5;
  const out: Bar[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + drift + rand() * 0.02);
    out.push({ t: i * 14400, o, h: Math.max(o, p) * 1.005, l: Math.min(o, p) * 0.995, c: p, v: 1000 + rand() * 100 });
  }
  return out;
}

const feat = (over: Partial<SignalFeatures>): SignalFeatures => ({
  asset: "BTC", close: 100, atr: 2, regime: "uptrend", highVol: false, rsi: 55, sentimentReasons: [],
  factors: { trend: 0.8, sentiment: 0, momentum: 0.6, relativeStrength: 0.3, positioning: 0.3 }, ...over,
});

describe("signal engine: adaptive ensemble", () => {
  it("generateSignal is exactly decideSignal over signalFeatures (backtest == live)", () => {
    const bars = synthBars(400, 0.002);
    const opts = { kind: "momentum" as const, minScore: 0.2, breakoutBars: 20 };
    expect(generateSignal({ asset: "BTC", bars }, opts)).toEqual(decideSignal(signalFeatures({ asset: "BTC", bars }, 20), opts));
  });
  it("trades momentum in uptrends, mean-reversion in ranges and nothing in downtrends", () => {
    const up = decideSignal(feat({}), { kind: "adaptive", minScore: 0.3 });
    expect(up.direction).toBe("long");
    expect(up.orderType).toBe("market");
    expect(up.reasons[0]).toContain("momentum");
    const range = decideSignal(feat({ regime: "range", rsi: 28 }), { kind: "adaptive", rsiOversold: 35 });
    expect(range.direction).toBe("long");
    expect(range.orderType).toBe("limit");
    expect(range.entry).toBeLessThan(100);
    expect(decideSignal(feat({ regime: "range", rsi: 50 }), { kind: "adaptive", rsiOversold: 35 }).direction).toBe("flat");
    expect(decideSignal(feat({ regime: "downtrend", rsi: 20 }), { kind: "adaptive" }).rejectedBy).toContain("downtrend");
  });
  it("maps templates to kinds", () => {
    expect(templateKind("spot-adaptive")).toBe("adaptive");
    expect(templateKind("spot-range")).toBe("mean-reversion");
    expect(templateKind("spot-dca")).toBe("dca");
    expect(templateKind("spot-momentum")).toBe("momentum");
  });
});

describe("backtester", () => {
  const p = (over: Partial<BacktestParams> = {}): BacktestParams => ({
    kind: "dca", piBps: 9500, multiplier: 3, riskPerTradePct: 0.5, maxMarginPct: 20, roundTripCostPct: 0.004,
    signal: { minScore: 0.35, minAgreeing: 3, minRewardRisk: 2, stopAtr: 2, targetAtr: 4, breakoutBars: 20, rsiOversold: 35 }, ...over,
  });
  it("respects CPPI: never risks the floor, sizes inside m * cushion", () => {
    const btc = synthBars(1400, 0.0004, 3, 30000), eth = synthBars(1400, 0.0002, 5, 2000);
    const series = [computeFeatureSeries("BTC", btc, { btc, eth }, [20]), computeFeatureSeries("ETH", eth, { btc, eth }, [20])];
    const r = simulate(series, () => p(), 0, btc.length);
    expect(r.stats.trades).toBeGreaterThan(0);
    expect(r.stats.floorHeld).toBe(true);
    for (const t of r.trades) expect(t.sizeFrac).toBeLessThanOrEqual(0.2 + 1e-9); // maxMarginPct
    expect(r.equity.every(Number.isFinite)).toBe(true);
  });
  it("fills the stop first when one bar spans stop and target", () => {
    const btc = synthBars(500, 0.002, 7, 30000);
    const series = [computeFeatureSeries("BTC", btc, { btc }, [20])];
    const first = simulate(series, () => p(), 0, btc.length).trades[0];
    expect(first).toBeDefined();
    // rewrite the entry bar's successor to span both levels
    const i = btc.findIndex((b) => b.t === first.entryT);
    const wide = btc.map((b) => ({ ...b }));
    wide[i] = { ...wide[i], h: wide[i].o * 1.5, l: wide[i].o * 0.5 };
    const series2 = [{ ...series[0], bars: wide }];
    const t2 = simulate(series2, () => p(), 0, wide.length).trades.find((t) => t.entryT === first.entryT)!;
    expect(t2.reason).toBe("stop");
    expect(t2.pnl).toBeLessThan(0);
  });
});

describe("risk-tier presets", () => {
  it("ship valid, tier-locked configs with a predefined prompt", () => {
    expect(AGENT_PRESETS.map((x) => x.id)).toEqual(["conservative", "balanced", "aggressive"]);
    for (const preset of AGENT_PRESETS) {
      const c = validateStrategyConfig(preset.config);
      expect(c.riskTier).toBe(preset.id);
      expect(c.symbols).toEqual(["BTC", "ETH"]);
      expect(c.market).toBe("spot");
      expect(c.risk.riskPerTradePct).toBe(TIER_PROFILES[preset.id].riskPerTradePct);
      expect(preset.prompt).toContain(`${TIER_PROFILES[preset.id].piBps / 100}%`);
      expect(preset.prompt.length).toBeGreaterThan(100);
    }
    expect(TIER_PROFILES.conservative.piBps).toBeGreaterThan(TIER_PROFILES.balanced.piBps);
    expect(TIER_PROFILES.balanced.piBps).toBeGreaterThan(TIER_PROFILES.aggressive.piBps);
    expect(TIER_PROFILES.aggressive.multiplier).toBeLessThanOrEqual(4); // RiskGate setMultiplier bound
  });
  it("rejects unknown risk tiers", () => {
    expect(() => validateStrategyConfig({ ...presetConfig("balanced"), riskTier: "yolo" })).toThrow("riskTier");
  });
});

const policy = { ...tierFor(72), maxPromptTokens: 4000 };
const chat = (content: string, extra: object = {}) => new Response(JSON.stringify({ id: "x1", model: "fw-test", choices: [{ message: { content } }], usage: { total_tokens: 42 }, ...extra }), { status: 200 });
const fw = (send: (url: string, init: any) => Promise<Response>) => new FireworksBrain({ apiKey: "k", maxTokensPerHour: 1e5, maxTokensPerDay: 1e6 }, send as unknown as typeof fetch);

describe("0G -> Fireworks fallback", () => {
  it("calls Fireworks chat completions, strips reasoning and labels output external, never TEE", async () => {
    let sent: any;
    const r = await fw(async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return chat('<think>hmm</think>{"sentiment":0.3}'); }).think(policy, [{ role: "user", content: "BTC" }], 50);
    expect(sent.url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(sent.body.model).toBe(FIREWORKS_DEFAULT_MODEL);
    expect(r).toMatchObject({ content: '{"sentiment":0.3}', provider: "fireworks", verified: null, tee: null, verificationSource: "external", model: "fw-test" });
    expect(parseSentiment("Sure: {\"sentiment\": 2, \"reasons\": [\"a\"]}")).toEqual({ score: 1, reasons: ["a"] });
  });
  it("uses Fireworks only when 0G fails, and reports both causes when both fail", async () => {
    const failing: Brain = { mode: "live", fundingMode: "router", ledgerOg: async () => 0, depositOg: async () => "", teeSigner: async () => null, caps: () => ({}) as any, think: async () => { throw new Error("0G unreachable"); } };
    const brain = new FallbackBrain(failing, fw(async () => chat("{}")));
    expect((await brain.think(policy, [{ role: "user", content: "x" }], 10))?.provider).toBe("fireworks");
    // an unavailable endpoint rolls over to the next benchmarked model; an auth failure does not
    const tried: string[] = [];
    const roll = fw(async (_u, init) => { const m = JSON.parse(init.body).model; tried.push(m); return tried.length === 1 ? new Response("{}", { status: 503 }) : chat('{"sentiment":0}'); });
    expect((await roll.think(policy, [{ role: "user", content: "x" }], 10))?.content).toBe('{"sentiment":0}');
    expect(tried).toEqual([FIREWORKS_MODELS[0], FIREWORKS_MODELS[1]]);
    expect(brain.lastSource).toBe("fireworks");
    await expect(new FallbackBrain(failing, fw(async () => new Response("{}", { status: 401 }))).think(policy, [{ role: "user", content: "x" }], 10)).rejects.toThrow(/0G: 0G unreachable.*Fireworks fallback: Fireworks rejected the API key/);
    expect(await brain.think({ ...policy, model: null }, [], 10)).toBeNull(); // tier says no LLM
  });
  it("compiles a labelled Fireworks draft from a preset and keeps its risk tier", async () => {
    const base = presetConfig("conservative");
    const draft = { ...base, riskTier: "aggressive", symbols: ["BTC"] };
    const r = await compileStrategy(fw(async () => chat(JSON.stringify({ config: draft, assumptions: ["BTC only"], unsupportedRequirements: [] }))), "Only trade bitcoin please", base);
    expect(r.config.riskTier).toBe("conservative");
    expect(r.config.symbols).toEqual(["BTC"]);
    expect(r.proof.verificationSource).toBe("external");
  });
});

describe("rules attestation", () => {
  it("signs a canonical record RiskGate can recover", async () => {
    const att = new RulesAttester(LOCAL_RULES_SIGNER_KEY);
    const s = decideSignal(feat({}), { kind: "momentum", minScore: 0.3 });
    const r = await att.attest(s, { agent: "a", riskGate: "0xAbC0000000000000000000000000000000000001", chainId: 31337, kind: "momentum", candleT: 1, ai: null });
    expect(r.attestation).toBe("rules");
    expect(r.verified).toBe(false);
    expect(await verifyMessage({ address: att.address, message: r.tee!.text, signature: r.tee!.signature })).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ type: "perpetua-rules-attestation", asset: "BTC", direction: "long", riskGate: "0xabc0000000000000000000000000000000000001" });
  });
});
