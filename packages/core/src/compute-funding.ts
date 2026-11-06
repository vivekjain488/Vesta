/** Compute capital is separate from trading NAV. USD amounts use 6 decimals; 0G uses 18. */
export const COMPUTE_BOOTSTRAP_BPS = 2_000n;
export const COMPUTE_BOOTSTRAP_CAP_USD = 5_000_000n;

export function splitAgentDeposit(depositUsd: bigint) {
  if (depositUsd <= 0n) throw new Error("Deposit must be positive");
  const computeUsd = min(depositUsd * COMPUTE_BOOTSTRAP_BPS / 10_000n, COMPUTE_BOOTSTRAP_CAP_USD);
  return { depositUsd, computeUsd, tradingUsd: depositUsd - computeUsd };
}

export interface ComputeModelFunding {
  /** Trigger while there is still enough credit for a bounded funding decision. */
  minimumWei: bigint;
  /** Hysteresis: replenish above the trigger, rather than swapping on every tick. */
  targetWei: bigint;
  /** Worst-case reservation for the optional funding-only model call. */
  fundingDecisionWei: bigint;
}

export interface ComputeFundingPolicy {
  models: Record<"small" | "large", ComputeModelFunding>;
  profitShareBps: bigint;
  maxDailyUsd: bigint;
  minConversionUsd: bigint;
  maxRouteFeeBps: bigint;
  maxSlippageBps: bigint;
  cooldownMs: number;
  maxObservationAgeMs: number;
}

/** Values here are operating defaults, not model prices or executable conversion quotes. */
export const defaultComputeFundingPolicy = (): ComputeFundingPolicy => ({
  models: {
    small: { minimumWei: 250_000_000_000_000_000n, targetWei: 1_000_000_000_000_000_000n, fundingDecisionWei: 10_000_000_000_000_000n },
    large: { minimumWei: 750_000_000_000_000_000n, targetWei: 2_000_000_000_000_000_000n, fundingDecisionWei: 30_000_000_000_000_000n },
  },
  profitShareBps: 2_000n, maxDailyUsd: 5_000_000n, minConversionUsd: 100_000n,
  maxRouteFeeBps: 500n, maxSlippageBps: 100n, cooldownMs: 15 * 60_000, maxObservationAgeMs: 60_000,
});

export interface FundingQuote {
  observedAtMs: number;
  expiresAtMs: number;
  /** A route must identify its source/destination chains, token addresses and final ledger owner. */
  routeId: string;
  inputUsd: bigint;
  /** Guaranteed native 0G delivered to compute, after all route costs and gas reservations. */
  minimumComputeWei: bigint;
  feeUsd: bigint;
  slippageBps: bigint;
  executable: boolean;
}

export interface ComputeFundingObservation {
  observedAtMs: number;
  ownerSleeping: boolean;
  withdrawalPending: boolean;
  fundingMode: "ledger" | "router";
  model: "small" | "large";
  /** The immutable FIRST deposit; subsequent deposits do not repeatedly bootstrap the agent. */
  initialDepositUsd: bigint;
  bootstrapComplete: boolean;
  /** Segregated unspent bootstrap allocation, never principal inside the protected trading vault. */
  bootstrapCashUsd: bigint;
  /** Conservative usable credit, excluding gas, pending refunds and unsettled inference liabilities. */
  computeWei: bigint | null;
  /** Cumulative net realized trading profit, after losses, trading fees and perpetual funding.
   * Compute purchases are accounted separately below; never include unrealized PnL or deposits. */
  netRealizedProfitUsd: bigint;
  /** Total USD already converted (or irrevocably reserved) from the realized-profit allowance. */
  profitFundingUsedUsd: bigint;
  eligibleProfitCashUsd: bigint;
  /** Rolling 24h reservations, including pending conversions and their route fees. */
  fundedLast24hUsd: bigint;
  lastFundingAtMs: number | null;
  sourceGasReady: boolean;
  destinationGasReady: boolean;
  /** True only after the destination ledger minimum and selected provider requirements are known. */
  activationRequirementsKnown: boolean;
  minimumActivationWei: bigint;
}

export interface ComputeFundingPlan {
  action: "trade" | "fund" | "wait" | "sleep";
  reason: string;
  source?: "bootstrap" | "realized_profit";
  amountUsd: bigint;
  maxAvailableUsd: bigint;
  requiredComputeWei: bigint;
  allowFundingDecision: boolean;
}

const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
const max = (a: bigint, b: bigint) => a > b ? a : b;
const positive = (v: bigint) => v > 0n ? v : 0n;
function validatePolicy(p: ComputeFundingPolicy) {
  if (p.profitShareBps < 0n || p.profitShareBps > 10_000n || p.maxDailyUsd <= 0n || p.minConversionUsd <= 0n || p.maxRouteFeeBps < 0n || p.maxRouteFeeBps > 10_000n || p.maxSlippageBps < 0n || p.maxSlippageBps > 1_000n || !Number.isSafeInteger(p.cooldownMs) || p.cooldownMs < 0 || !Number.isSafeInteger(p.maxObservationAgeMs) || p.maxObservationAgeMs <= 0) throw new Error("Invalid compute funding policy");
  for (const model of Object.values(p.models)) if (model.fundingDecisionWei <= 0n || model.minimumWei < model.fundingDecisionWei || model.targetWei <= model.minimumWei) throw new Error("Invalid model compute thresholds");
}

/** Mandatory funding takes priority over new entries. Stops, exits and owner withdrawals use no model. */
export function planComputeFunding(o: ComputeFundingObservation, p: ComputeFundingPolicy, nowMs: number, quote?: FundingQuote): ComputeFundingPlan {
  validatePolicy(p);
  const stop = (reason: string, action: "wait" | "sleep" = "wait"): ComputeFundingPlan => ({ action, reason, amountUsd: 0n, maxAvailableUsd: 0n, requiredComputeWei: 0n, allowFundingDecision: false });
  if (o.ownerSleeping || o.withdrawalPending) return stop("owner_sleep_or_withdrawal", "sleep");
  if (o.observedAtMs > nowMs + 1_000 || nowMs - o.observedAtMs > p.maxObservationAgeMs) return stop("stale_funding_observation");
  if (o.fundingMode === "router") return stop("router_requires_separate_balance_and_payment_adapter");
  if (o.computeWei === null || o.computeWei < 0n) return stop("compute_balance_unknown");
  if (o.initialDepositUsd <= 0n || o.bootstrapCashUsd < 0n || o.profitFundingUsedUsd < 0n || o.eligibleProfitCashUsd < 0n || o.fundedLast24hUsd < 0n || o.minimumActivationWei < 0n) return stop("invalid_funding_observation");
  const model = p.models[o.model];
  if (o.bootstrapComplete && o.computeWei >= model.minimumWei) return { ...stop("compute_healthy"), action: "trade" };
  if (!o.activationRequirementsKnown) return stop("activation_requirements_unknown");
  const source = o.bootstrapComplete ? "realized_profit" : "bootstrap";
  const bootstrap = splitAgentDeposit(o.initialDepositUsd).computeUsd;
  const available = source === "bootstrap" ? min(bootstrap, positive(o.bootstrapCashUsd)) : min(positive(o.netRealizedProfitUsd * p.profitShareBps / 10_000n - o.profitFundingUsedUsd), positive(o.eligibleProfitCashUsd));
  const maxAvailableUsd = min(available, positive(p.maxDailyUsd - o.fundedLast24hUsd));
  const requiredComputeWei = source === "bootstrap" ? positive(max(o.minimumActivationWei, model.minimumWei + model.fundingDecisionWei) - o.computeWei) : positive(model.targetWei - o.computeWei);
  const base: ComputeFundingPlan = { ...stop("quote_required"), source, maxAvailableUsd, requiredComputeWei };
  if (maxAvailableUsd < p.minConversionUsd) return { ...base, reason: source === "bootstrap" ? "bootstrap_below_minimum_budget" : "await_realized_profit_or_daily_budget" };
  if (o.lastFundingAtMs !== null && nowMs - o.lastFundingAtMs < p.cooldownMs) return { ...base, reason: "funding_cooldown" };
  if (!o.sourceGasReady || !o.destinationGasReady) return { ...base, reason: "gas_reserve_required" };
  if (!quote) return base;
  if (!quote.executable || !quote.routeId || quote.observedAtMs > nowMs + 1_000 || nowMs - quote.observedAtMs > p.maxObservationAgeMs || quote.expiresAtMs <= nowMs) return { ...base, reason: "route_unavailable_or_expired" };
  if (quote.inputUsd < p.minConversionUsd || quote.inputUsd > maxAvailableUsd || quote.feeUsd < 0n || quote.feeUsd >= quote.inputUsd || quote.feeUsd * 10_000n > quote.inputUsd * p.maxRouteFeeBps || quote.slippageBps < 0n || quote.slippageBps > p.maxSlippageBps || quote.minimumComputeWei <= 0n) return { ...base, reason: "route_outside_budget_or_cost_limits" };
  if (!o.bootstrapComplete && quote.inputUsd !== bootstrap) return { ...base, reason: "bootstrap_allocation_must_be_complete" };
  // Bootstrap must actually activate inference, rather than lock a too-small amount in an unusable ledger.
  if (!o.bootstrapComplete && quote.minimumComputeWei < requiredComputeWei) return { ...base, reason: "bootstrap_cannot_meet_provider_minimum" };
  // A partial refill is allowed, but it must clear the selected model's low-water threshold.
  if (o.bootstrapComplete && o.computeWei + quote.minimumComputeWei < model.minimumWei) return { ...base, reason: "refill_cannot_clear_model_threshold" };
  return { ...base, action: "fund", reason: source === "bootstrap" ? "bootstrap_before_first_trade" : "compute_low_profit_refill", amountUsd: quote.inputUsd, allowFundingDecision: o.bootstrapComplete && o.computeWei >= model.fundingDecisionWei };
}
