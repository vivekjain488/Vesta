import { tierFor, runwayHours, type TierPolicy } from "./router";
import type { StrategyConfig } from "./agent-config";

/** Capital is verified allocated equity, never a user's wallet balance or a requested size cap. */
export function capitalModelPolicy(config: StrategyConfig, equityUsd: number, ledgerOg: number): TierPolicy {
  const rules = { ...tierFor(0) };
  if (!Number.isFinite(equityUsd) || !Number.isFinite(ledgerOg) || equityUsd < config.compute.minimumCapitalUsd || ledgerOg <= 0) return rules;
  const hours = runwayHours({ ledgerBalanceOg: ledgerOg, reserveOg: config.compute.reserveOg, burnOgPerHour: config.compute.estimatedBurnOgPerHour });
  const policy = { ...tierFor(hours) };
  if (policy.model === "large" && equityUsd < config.compute.premiumCapitalThresholdUsd) policy.model = "small";
  return policy;
}
