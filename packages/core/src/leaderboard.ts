/**
 * Strictly dynamic, hard-to-game leaderboard. Recomputed from scratch every poke() cycle from Arkiv rows;
 * each cycle's score vector is itself written back to Arkiv as a LeaderboardSnapshot.
 *
 * Score = Sortino^a * Accuracy^b * RiskPenalty^g * Transparency^d * sqrt(min(TrackDays,180)/90)
 * Geometric on purpose: a near-zero in any factor collapses the score.
 */

export type RiskTier = "conservative" | "balanced" | "aggressive";

export interface DailyReturn {
  t: number; // unix seconds (day close)
  r: number; // simple return, decimal
}

export interface SignalOutcome {
  p: number; // predicted win probability (published confidence)
  o: 0 | 1; // realised outcome
}

export interface AgentHistory {
  agent: string;
  tier: RiskTier;
  returns: DailyReturn[];
  outcomes: SignalOutcome[];
  decisions: number;
  verifiedDecisions: number; // backed by a 0G TEE-verified inference proof logged to Arkiv
  firstSeen: number;
  lastSettledTrade: number;
}

export interface ScoreWeights {
  alpha: number;
  beta: number;
  gamma: number;
  delta: number;
  lambda: number; // CVaR weight in the risk penalty
}

export const TIER_WEIGHTS: Record<RiskTier, ScoreWeights> = {
  conservative: { alpha: 1, beta: 1, gamma: 1.5, delta: 0.5, lambda: 3 },
  balanced: { alpha: 1, beta: 1, gamma: 1, delta: 0.5, lambda: 2 },
  aggressive: { alpha: 1, beta: 1, gamma: 0.75, delta: 0.5, lambda: 1 },
};

const HALF_LIFE_DAYS = 30;
const INACTIVITY_HALF_LIFE_DAYS = 14;
const DAY = 86400;

/** Exponentially time-decayed Sortino ratio (downside deviation only), annualised. */
export function decayedSortino(returns: DailyReturn[], now: number, halfLifeDays = HALF_LIFE_DAYS): number {
  if (returns.length < 2) return 0;
  const lambda = Math.log(2) / halfLifeDays;
  let wSum = 0;
  let mean = 0;
  let downside = 0;
  for (const x of returns) {
    const w = Math.exp(-lambda * ((now - x.t) / DAY));
    wSum += w;
    mean += w * x.r;
    downside += w * Math.min(0, x.r) ** 2;
  }
  mean /= wSum;
  const dd = Math.sqrt(downside / wSum);
  if (dd === 0) return mean > 0 ? 10 : 0; // no losing days: cap instead of infinity
  return (mean / dd) * Math.sqrt(365);
}

export function brierScore(outcomes: SignalOutcome[]): number {
  if (outcomes.length === 0) return 0.25; // uninformed prior (p = 0.5 always)
  return outcomes.reduce((s, x) => s + (x.p - x.o) ** 2, 0) / outcomes.length;
}

export const accuracy = (outcomes: SignalOutcome[]) => 1 - brierScore(outcomes);

export function maxDrawdown(returns: DailyReturn[]): number {
  let peak = 1;
  let eq = 1;
  let mdd = 0;
  for (const x of returns) {
    eq *= 1 + x.r;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, (peak - eq) / peak);
  }
  return mdd;
}

/** CVaR at 95%: mean loss of the worst 5% of days (as a positive number). */
export function cvar95(returns: DailyReturn[]): number {
  if (returns.length === 0) return 0;
  const sorted = returns.map((x) => x.r).sort((a, b) => a - b);
  const n = Math.max(1, Math.floor(sorted.length * 0.05));
  const tail = sorted.slice(0, n);
  return Math.max(0, -tail.reduce((a, b) => a + b, 0) / n);
}

export const riskPenalty = (returns: DailyReturn[], lambda: number) =>
  1 / (1 + maxDrawdown(returns) + lambda * cvar95(returns));

export const transparency = (h: Pick<AgentHistory, "decisions" | "verifiedDecisions">) =>
  h.decisions === 0 ? 0 : h.verifiedDecisions / h.decisions;

export interface ScoreBreakdown {
  agent: string;
  tier: RiskTier;
  sortino: number;
  accuracy: number;
  brier: number;
  riskPenalty: number;
  maxDrawdown: number;
  cvar95: number;
  transparency: number;
  trackDays: number;
  trackFactor: number;
  inactivityFactor: number;
  score: number;
  unverified: boolean;
}

export function scoreAgent(h: AgentHistory, now: number): ScoreBreakdown {
  const w = TIER_WEIGHTS[h.tier];
  // Sortino can be negative; map it into (0, inf) with a soft floor so the geometric product stays defined
  // and a losing agent still ranks below a flat one.
  const sortino = decayedSortino(h.returns, now);
  const sortinoPos = Math.log1p(Math.exp(sortino)); // softplus
  const acc = accuracy(h.outcomes);
  const rp = riskPenalty(h.returns, w.lambda);
  const tr = transparency(h);
  const trackDays = (now - h.firstSeen) / DAY;
  const trackFactor = Math.sqrt(Math.min(trackDays, 180) / 90);
  const idleDays = Math.max(0, (now - h.lastSettledTrade) / DAY - 7);
  const inactivityFactor = Math.pow(0.5, idleDays / INACTIVITY_HALF_LIFE_DAYS);
  const score =
    Math.pow(sortinoPos, w.alpha) *
    Math.pow(acc, w.beta) *
    Math.pow(rp, w.gamma) *
    Math.pow(tr, w.delta) *
    trackFactor *
    inactivityFactor;
  return {
    agent: h.agent,
    tier: h.tier,
    sortino,
    accuracy: acc,
    brier: brierScore(h.outcomes),
    riskPenalty: rp,
    maxDrawdown: maxDrawdown(h.returns),
    cvar95: cvar95(h.returns),
    transparency: tr,
    trackDays,
    trackFactor,
    inactivityFactor,
    score,
    unverified: trackDays < 30,
  };
}

export function rankAgents(histories: AgentHistory[], now: number) {
  const all = histories.map((h) => scoreAgent(h, now)).sort((a, b) => b.score - a.score);
  const byTier: Record<RiskTier, ScoreBreakdown[]> = { conservative: [], balanced: [], aggressive: [] };
  for (const s of all) byTier[s.tier].push(s);
  return { crossTier: all, byTier };
}
