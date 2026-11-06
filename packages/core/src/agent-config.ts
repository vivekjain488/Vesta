import { getAddress, isAddress, keccak256, toBytes, type Address } from "viem";

/** Versioned, data-only strategy DSL. No generated code, addresses, keys, or arbitrary tools. */
export interface StrategyConfig {
  version: 1;
  template: "spot-momentum" | "spot-range" | "spot-dca" | "spot-breakout" | "spot-bollinger" | "spot-rsi-recovery" | "perp-trend" | "perp-range";
  market: "spot" | "perpetual";
  symbols: string[];
  timeframe: "4h";
  direction: "long" | "short" | "both";
  parameters: { minScore: number; minAgreeing: number; minRewardRisk: number; stopAtr: number; targetAtr: number; breakoutBars: number; rsiOversold: number };
  risk: { maxLeverage: number; riskPerTradePct: number; maxNotionalUsd: number; maxMarginPct: number; maxDailyLossPct: number };
  compute: { premiumCapitalThresholdUsd: number; minimumCapitalUsd: number; maxDailySpendOg: number; reserveOg: number; estimatedBurnOgPerHour: number };
  execution: { pollSeconds: number; assumedDelaySeconds: number; maxDecisionAgeSeconds: number; maxQuoteAgeSeconds: number; maxPriceDriftBps: number; maxSpreadBps: number; maxSlippageBps: number; maxRoundTripCostBps: number; minHoldSeconds: number };
}

export interface AgentDefinition {
  id: string;
  owner: Address;
  name: string;
  instructions?: string;
  revision: number;
  status: "draft" | "paper" | "sleeping";
  config: StrategyConfig;
  configHash: string;
  createdAt: number;
  updatedAt: number;
}

export function normalizedAgentName(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  if (!/^[\p{L}\p{N} _-]{1,60}$/u.test(normalized)) throw new Error("Name must contain 1–60 letters, digits, spaces, underscores or hyphens");
  return normalized;
}

export const STRATEGY_TEMPLATES = [
  { id: "spot-momentum", label: "Spot momentum", market: "spot", description: "Long-only trend entries using closed 4h candles." },
  { id: "spot-range", label: "Spot range reversion", market: "spot", description: "Long-only oversold entries in range regimes." },
  { id: "spot-dca", label: "Spot accumulation", market: "spot", description: "Small bracketed buys in non-downtrend regimes." },
  { id: "spot-breakout", label: "Channel breakout", market: "spot", description: "Follow a close above the prior channel high; monitor the lower channel for exits." },
  { id: "spot-bollinger", label: "Band reversion", market: "spot", description: "Look for a recovery through the lower volatility band; monitor the mean for exits." },
  { id: "spot-rsi-recovery", label: "RSI recovery", market: "spot", description: "Look for RSI to recover from oversold; monitor overbought momentum for exits." },
  { id: "perp-trend", label: "Futures trend", market: "perpetual", description: "Paper research: long/short closed-candle breakouts, held over hours or days." },
  { id: "perp-range", label: "Futures range reversion", market: "perpetual", description: "Paper research: long/short oversold or overbought entries in ranges." },
] as const;

/** Reviewable presets, not predictions of returns or maximum losses. */
export const RISK_PROFILES = {
  cautious: { label: "Cautious", description: "Smaller orders and stronger entry confirmation.", maxNotionalUsd: 50, riskPerTradePct: 0.1, maxDailyLossPct: 0.75, minScore: 0.55, minAgreeing: 4, minHoldSeconds: 7200, instructions: "Prioritize capital preservation. Require strong, corroborated evidence before increasing exposure; size conservatively and actively consider reducing existing exposure when risk rises." },
  balanced: { label: "Balanced", description: "Moderate order size and entry confirmation.", maxNotionalUsd: 100, riskPerTradePct: 0.25, maxDailyLossPct: 2, minScore: 0.35, minAgreeing: 3, minHoldSeconds: 3600, instructions: "Balance opportunity and downside. Use moderate position sizes and weigh evidence for both increasing and reducing exposure." },
  aggressive: { label: "Aggressive", description: "Larger orders and a lower entry threshold, within the configured limits.", maxNotionalUsd: 250, riskPerTradePct: 0.75, maxDailyLossPct: 4, minScore: 0.15, minAgreeing: 2, minHoldSeconds: 900, instructions: "Seek opportunities more actively and consider larger positions when evidence supports them. Accept more volatility within the configured risk limits; do not trade without a reason." },
} as const;
export type RiskProfile = keyof typeof RISK_PROFILES;
export function applyRiskProfile(config: StrategyConfig, profile: RiskProfile): StrategyConfig {
  const p = RISK_PROFILES[profile]; if (!p) throw new Error("Unknown risk profile");
  const c = structuredClone(config);
  c.risk.maxNotionalUsd = p.maxNotionalUsd; c.risk.riskPerTradePct = p.riskPerTradePct; c.risk.maxDailyLossPct = p.maxDailyLossPct;
  c.parameters.minScore = p.minScore; c.parameters.minAgreeing = p.minAgreeing; c.execution.minHoldSeconds = Math.max(p.minHoldSeconds, c.execution.assumedDelaySeconds * 10);
  return validateStrategyConfig(c);
}

export function templateConfig(template: StrategyConfig["template"]): StrategyConfig {
  if (!STRATEGY_TEMPLATES.some((t) => t.id === template)) throw new Error("Unknown strategy template");
  const market = template.startsWith("perp-") ? "perpetual" : "spot";
  return {
    version: 1, template, market, symbols: ["BTC", "ETH"], timeframe: "4h", direction: market === "spot" ? "long" : "both",
    parameters: { minScore: 0.35, minAgreeing: 3, minRewardRisk: 2, stopAtr: 2, targetAtr: market === "perpetual" ? 6 : 4, breakoutBars: 20, rsiOversold: 35 },
    risk: { maxLeverage: market === "spot" ? 1 : 2, riskPerTradePct: 0.25, maxNotionalUsd: 100, maxMarginPct: 20, maxDailyLossPct: 2 },
    compute: { premiumCapitalThresholdUsd: 5000, minimumCapitalUsd: 25, maxDailySpendOg: 1, reserveOg: 2, estimatedBurnOgPerHour: 0.02 },
    execution: { pollSeconds: 60, assumedDelaySeconds: 30, maxDecisionAgeSeconds: 90, maxQuoteAgeSeconds: 3, maxPriceDriftBps: 25, maxSpreadBps: 10, maxSlippageBps: 20, maxRoundTripCostBps: 100, minHoldSeconds: 3600 },
  };
}

function object(v: unknown, keys: readonly string[], path: string): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${path}: expected object`);
  for (const key of Object.keys(v)) if (!keys.includes(key)) throw new Error(`${path}: unsupported field ${key}`);
  for (const key of keys) if (!(key in v)) throw new Error(`${path}: missing ${key}`);
  return v as Record<string, any>;
}
function number(v: unknown, min: number, max: number, path: string, integer = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new Error(`${path}: expected ${integer ? "integer" : "number"} in [${min}, ${max}]`);
  return v;
}

/** Strict validation applies identically to templates, browser edits and AI output. Percentages use 0..100. */
export function validateStrategyConfig(input: unknown): StrategyConfig {
  const c = object(input, ["version", "template", "market", "symbols", "timeframe", "direction", "parameters", "risk", "compute", "execution"], "config");
  if (c.version !== 1 || c.timeframe !== "4h") throw new Error("Only schema version 1 and closed 4h candles are supported");
  const base = templateConfig(c.template);
  if (c.market !== base.market) throw new Error("Template and market disagree");
  if (!["long", "short", "both"].includes(c.direction) || (c.market === "spot" && c.direction !== "long")) throw new Error("Spot supports long-only; futures supports long/short/both");
  if (!Array.isArray(c.symbols) || !c.symbols.length || c.symbols.length > 5 || c.symbols.some((s: unknown) => typeof s !== "string" || !/^[A-Z0-9]{2,12}$/.test(s)) || new Set(c.symbols).size !== c.symbols.length) throw new Error("Choose 1–5 distinct uppercase asset symbols");
  const p = object(c.parameters, Object.keys(base.parameters), "parameters");
  const r = object(c.risk, Object.keys(base.risk), "risk");
  const e = object(c.execution, Object.keys(base.execution), "execution");
  const compute = object(c.compute, Object.keys(base.compute), "compute");
  number(compute.premiumCapitalThresholdUsd, 100, 1_000_000, "premiumCapitalThresholdUsd"); number(compute.minimumCapitalUsd, 1, 1000, "minimumCapitalUsd");
  number(compute.maxDailySpendOg, 0.001, 100, "maxDailySpendOg"); number(compute.reserveOg, 0, 100, "reserveOg"); number(compute.estimatedBurnOgPerHour, 0.00001, 10, "estimatedBurnOgPerHour");
  if (compute.minimumCapitalUsd >= compute.premiumCapitalThresholdUsd) throw new Error("Premium model threshold must exceed minimum capital");
  number(p.minScore, 0, 1, "minScore"); number(p.minAgreeing, 1, 5, "minAgreeing", true); number(p.minRewardRisk, 1.5, 10, "minRewardRisk");
  number(p.stopAtr, 1, 5, "stopAtr"); number(p.targetAtr, 1.5, 15, "targetAtr"); number(p.breakoutBars, 10, 100, "breakoutBars", true); number(p.rsiOversold, 10, 40, "rsiOversold");
  if (p.targetAtr / p.stopAtr < p.minRewardRisk) throw new Error("ATR target/stop must meet minRewardRisk");
  number(r.maxLeverage, 1, c.market === "spot" ? 1 : 2, "maxLeverage"); number(r.riskPerTradePct, 0.01, 1, "riskPerTradePct");
  number(r.maxNotionalUsd, 1, 100_000, "maxNotionalUsd"); number(r.maxMarginPct, 1, 25, "maxMarginPct"); number(r.maxDailyLossPct, 0.1, 5, "maxDailyLossPct");
  if (r.riskPerTradePct > r.maxDailyLossPct) throw new Error("Per-trade risk exceeds daily loss limit");
  number(e.pollSeconds, 5, 300, "pollSeconds", true); number(e.assumedDelaySeconds, 1, 120, "assumedDelaySeconds", true);
  number(e.maxDecisionAgeSeconds, 5, 300, "maxDecisionAgeSeconds", true); number(e.maxQuoteAgeSeconds, 1, 10, "maxQuoteAgeSeconds", true);
  number(e.maxPriceDriftBps, 1, 100, "maxPriceDriftBps"); number(e.maxSpreadBps, 1, 50, "maxSpreadBps"); number(e.maxSlippageBps, 1, 100, "maxSlippageBps"); number(e.maxRoundTripCostBps, 1, 300, "maxRoundTripCostBps"); number(e.minHoldSeconds, 900, 604800, "minHoldSeconds", true);
  if (e.maxDecisionAgeSeconds < e.assumedDelaySeconds || e.minHoldSeconds < 10 * e.assumedDelaySeconds) throw new Error("Decision expiry/holding horizon is too short for the assumed execution delay");
  return structuredClone(c) as StrategyConfig;
}

/** Stable hashes bind the exact config to owner signatures and audit records. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(",")}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Non-JSON input");
  return json;
}
export const configHash = (value: unknown) => keccak256(toBytes(canonicalJson(value)));
export function ownerAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error("Invalid owner wallet");
  return getAddress(value);
}
export function configAuthMessage(owner: string, action: string, payload: unknown, nonce: string, expiresAt: number, audience: string): string {
  return ["VESTA strategy configuration v1", `Service: ${audience}`, `Owner: ${ownerAddress(owner)}`, `Action: ${action}`, `Payload: ${configHash(payload)}`, `Nonce: ${nonce}`, `Expires: ${expiresAt}`].join("\n");
}
