/**
 * 0G Decision Router: the metabolism. Model choice is a cost lever. The agent reads its own runway and
 * walks down the ladder (Thrive -> Frugal -> Starving -> Hibernate) when food is short, and back up when
 * income lands. Thresholds are starting values; tune them against measured 0G prices.
 */

export type Tier = "thrive" | "frugal" | "starving" | "hibernate";

export interface TierPolicy {
  tier: Tier;
  minRunwayHours: number;
  model: "large" | "small" | null;
  maxCandidates: number;
  maxPromptTokens: number;
  postsReasoning: boolean;
  canHireHelpers: boolean;
  managesPositionsOnly: boolean;
  closesRiskyPositions: boolean;
}

export const LADDER: TierPolicy[] = [
  { tier: "thrive", minRunwayHours: 7 * 24, model: "large", maxCandidates: 3, maxPromptTokens: 4000, postsReasoning: true, canHireHelpers: true, managesPositionsOnly: false, closesRiskyPositions: false },
  { tier: "frugal", minRunwayHours: 2 * 24, model: "small", maxCandidates: 1, maxPromptTokens: 1200, postsReasoning: true, canHireHelpers: false, managesPositionsOnly: false, closesRiskyPositions: false },
  { tier: "starving", minRunwayHours: 12, model: null, maxCandidates: 0, maxPromptTokens: 0, postsReasoning: false, canHireHelpers: false, managesPositionsOnly: true, closesRiskyPositions: false },
  { tier: "hibernate", minRunwayHours: 0, model: null, maxCandidates: 0, maxPromptTokens: 0, postsReasoning: false, canHireHelpers: false, managesPositionsOnly: true, closesRiskyPositions: true },
];

export function tierFor(runwayHours: number): TierPolicy {
  return LADDER.find((p) => runwayHours > p.minRunwayHours) ?? LADDER[LADDER.length - 1];
}

/**
 * Runway = spendable compute balance / burn rate. The compute reserve R may only be spent below Frugal,
 * so above that tier it is excluded from what the agent considers spendable.
 */
export function runwayHours(opts: {
  ledgerBalanceOg: number;
  reserveOg: number;
  burnOgPerHour: number;
  includeReserve?: boolean;
}): number {
  if (opts.burnOgPerHour <= 0) return Infinity;
  const spendable = opts.includeReserve ? opts.ledgerBalanceOg : Math.max(0, opts.ledgerBalanceOg - opts.reserveOg);
  return spendable / opts.burnOgPerHour;
}

export type DecisionKind = "heartbeat" | "rotation" | "regime_change" | "trade_proposal" | "large_allocation" | "follower_onboarding";

export interface ModelCost {
  id: string;
  tier: "small" | "mid" | "large";
  estCostUsdPerCall: number;
}

/**
 * Value-at-stake gate: escalate to a pricier model only when the dollar exposure the decision affects is at
 * least `multiple` x that model's cost. Never spend $0.50 deciding something worth $2.
 */
export function pickModel(opts: {
  decision: DecisionKind;
  exposureUsd: number;
  policy: TierPolicy;
  models: ModelCost[];
  multiple?: number;
}): ModelCost | null {
  if (opts.decision === "heartbeat") return null; // rules only
  if (!opts.policy.model) return null;
  const multiple = opts.multiple ?? 50;
  const wanted: ModelCost["tier"][] =
    opts.decision === "regime_change" || opts.decision === "large_allocation" || opts.decision === "follower_onboarding"
      ? ["large", "mid", "small"]
      : opts.decision === "rotation"
        ? ["mid", "small"]
        : ["large", "mid", "small"];
  const allowed = opts.policy.model === "small" ? wanted.filter((t) => t === "small") : wanted;
  for (const t of allowed) {
    const m = opts.models.find((x) => x.tier === t);
    if (m && opts.exposureUsd >= m.estCostUsdPerCall * multiple) return m;
  }
  return null;
}

/** Runtime spend cap (layer 1 of 3): hard per-hour and per-day token budgets in the agent loop itself. */
export class SpendCap {
  private hour = { start: 0, tokens: 0 };
  private day = { start: 0, tokens: 0 };
  constructor(
    public readonly maxTokensPerHour: number,
    public readonly maxTokensPerDay: number,
  ) {}
  private roll(now: number) {
    if (now - this.hour.start >= 3600) this.hour = { start: now, tokens: 0 };
    if (now - this.day.start >= 86400) this.day = { start: now, tokens: 0 };
  }
  canSpend(tokens: number, now = Math.floor(Date.now() / 1000)) {
    this.roll(now);
    return this.hour.tokens + tokens <= this.maxTokensPerHour && this.day.tokens + tokens <= this.maxTokensPerDay;
  }
  record(tokens: number, now = Math.floor(Date.now() / 1000)) {
    this.roll(now);
    this.hour.tokens += tokens;
    this.day.tokens += tokens;
  }
  snapshot() {
    return { hourTokens: this.hour.tokens, dayTokens: this.day.tokens, maxPerHour: this.maxTokensPerHour, maxPerDay: this.maxTokensPerDay };
  }
}

/** Cheap rules filter that decides whether the LLM wakes up at all. Most cycles cost nothing. */
export function shouldWake(opts: {
  newBarClosed: boolean;
  volSpike: boolean;
  crossedLevel: boolean;
  mandateChanged: boolean;
  hoursSinceLastThought: number;
  maxSleepHours?: number;
}): { wake: boolean; reason: string } {
  if (opts.mandateChanged) return { wake: true, reason: "mandate changed" };
  if (opts.volSpike) return { wake: true, reason: "volatility spike" };
  if (opts.crossedLevel) return { wake: true, reason: "price crossed a level" };
  if (opts.newBarClosed && opts.hoursSinceLastThought >= 4) return { wake: true, reason: "4h bar closed" };
  if (opts.hoursSinceLastThought >= (opts.maxSleepHours ?? 24)) return { wake: true, reason: "daily review" };
  return { wake: false, reason: "nothing changed" };
}
