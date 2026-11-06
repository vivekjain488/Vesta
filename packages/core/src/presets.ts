/**
 * Risk-tier presets: one tap creates an agent whose rules were tuned by walk-forward optimisation on real
 * BTC/ETH 4h history (scripts/optimize-presets.ts). The numbers shipped with each preset are OUT-OF-SAMPLE
 * results after costs. Past performance does not predict future returns; nothing here is a profit guarantee.
 */
import { templateConfig, type RiskTierId, type StrategyConfig } from "./agent-config";
import type { BacktestStats, TierRisk } from "./backtest";
import type { StrategyKind } from "./strategy";
import { PRESET_TUNING } from "./presets.generated";

export interface TierTuning {
  kind: StrategyKind;
  parameters: StrategyConfig["parameters"];
  /** stitched out-of-sample result of the walk-forward procedure (null until the optimizer has run) */
  walkForward: BacktestStats | null;
  /** the shipped parameters on the window they were fitted on: in-sample, shown for transparency only */
  inSample: BacktestStats | null;
  folds: { trainFrom: string; trainTo: string; testFrom: string; testTo: string; kind: StrategyKind; testReturnPct: number; testMaxDrawdownPct: number; testTrades: number }[];
}

export interface PresetTuningFile {
  generatedAt: string | null;
  dataSource: string | null;
  method: string | null;
  costRoundTripPct: number;
  tiers: Record<RiskTierId, TierTuning>;
}

export interface TierProfile extends TierRisk {
  id: RiskTierId;
  label: string;
  tagline: string;
  /** RiskGate's immutable on-chain tier: 0 conservative, 1 balanced, 2 aggressive */
  onchainTier: 0 | 1 | 2;
  maxDailyLossPct: number;
  maxNotionalUsd: number;
  /** optimizer rejects any parameter set whose training drawdown exceeds this */
  drawdownCapPct: number;
}

export const TIER_PROFILES: Record<RiskTierId, TierProfile> = {
  conservative: { id: "conservative", label: "Conservative", tagline: "Capital first. 97% floor, smallest positions.", onchainTier: 0, piBps: 9700, multiplier: 2, riskPerTradePct: 0.25, maxMarginPct: 10, maxDailyLossPct: 1, maxNotionalUsd: 250, drawdownCapPct: 3 },
  balanced: { id: "balanced", label: "Balanced", tagline: "Steady growth. 95% floor, moderate positions.", onchainTier: 1, piBps: 9500, multiplier: 3, riskPerTradePct: 0.5, maxMarginPct: 20, maxDailyLossPct: 2, maxNotionalUsd: 1000, drawdownCapPct: 8 },
  aggressive: { id: "aggressive", label: "Aggressive", tagline: "Higher upside. 90% floor, largest positions.", onchainTier: 2, piBps: 9000, multiplier: 4, riskPerTradePct: 1, maxMarginPct: 25, maxDailyLossPct: 4, maxNotionalUsd: 2500, drawdownCapPct: 15 },
};

export function tierProfile(tier: RiskTierId | undefined): TierProfile {
  return TIER_PROFILES[tier ?? "balanced"] ?? TIER_PROFILES.balanced;
}

const KIND_TEMPLATE: Record<StrategyKind, StrategyConfig["template"]> = { momentum: "spot-momentum", "mean-reversion": "spot-range", dca: "spot-dca", adaptive: "spot-adaptive" };
const KIND_WORDS: Record<StrategyKind, string> = {
  adaptive: "Switch with the market regime: buy confirmed breakouts while BTC/ETH trend up, buy oversold dips while they range, and stay flat in downtrends",
  momentum: "Buy confirmed trend breakouts only while the market trends up; never chase overbought moves and stay flat outside uptrends",
  "mean-reversion": "Buy oversold dips only while the market is range-bound; stay flat when it trends down",
  dca: "Accumulate in small bracketed buys whenever the market is not in a downtrend",
};

export function presetConfig(tier: RiskTierId): StrategyConfig {
  const t = PRESET_TUNING.tiers[tier];
  const p = TIER_PROFILES[tier];
  const base = templateConfig(KIND_TEMPLATE[t.kind]);
  return {
    ...base,
    riskTier: tier,
    symbols: ["BTC", "ETH"],
    parameters: { ...t.parameters },
    risk: { ...base.risk, riskPerTradePct: p.riskPerTradePct, maxMarginPct: p.maxMarginPct, maxDailyLossPct: p.maxDailyLossPct, maxNotionalUsd: p.maxNotionalUsd },
  };
}

/** The predefined mandate for each tier. It is shown to the user, editable, and given to the model as context. */
export function presetPrompt(tier: RiskTierId): string {
  const t = PRESET_TUNING.tiers[tier];
  const p = TIER_PROFILES[tier];
  const q = t.parameters;
  return [
    `${p.label} agent. Trade BTC and ETH spot, long-only, on closed 4-hour candles.`,
    `${KIND_WORDS[t.kind]}.`,
    `Protect ${(p.piBps / 100).toFixed(0)}% of my deposit as a floor; only the cushion above it may be at risk, with total exposure capped at ${p.multiplier}x that cushion.`,
    `Risk at most ${p.riskPerTradePct}% of the vault per trade and ${p.maxDailyLossPct}% per day. Every entry carries a stop ${q.stopAtr}x ATR below and a take-profit ${q.targetAtr}x ATR above.`,
    `Use 0G to read the news for each asset; skip the trade when the news is clearly negative.`,
  ].join(" ");
}

export interface AgentPreset {
  id: RiskTierId;
  profile: TierProfile;
  kind: StrategyKind;
  prompt: string;
  config: StrategyConfig;
  backtest: { walkForward: BacktestStats | null; inSample: BacktestStats | null; folds: TierTuning["folds"]; generatedAt: string | null; dataSource: string | null; method: string | null; costRoundTripPct: number };
}

export function agentPreset(tier: RiskTierId): AgentPreset {
  const t = PRESET_TUNING.tiers[tier];
  return {
    id: tier,
    profile: TIER_PROFILES[tier],
    kind: t.kind,
    prompt: presetPrompt(tier),
    config: presetConfig(tier),
    backtest: { walkForward: t.walkForward, inSample: t.inSample, folds: t.folds, generatedAt: PRESET_TUNING.generatedAt, dataSource: PRESET_TUNING.dataSource, method: PRESET_TUNING.method, costRoundTripPct: PRESET_TUNING.costRoundTripPct },
  };
}

export const AGENT_PRESETS: AgentPreset[] = (["conservative", "balanced", "aggressive"] as const).map(agentPreset);
