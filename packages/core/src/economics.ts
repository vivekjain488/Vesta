/**
 * Unit economics. EVERY number here is a planning assumption: replace with measured values
 * (scripts/measure-0g-cost.ts, scripts/measure-gas.ts) on day one. The model reproduces the spec's
 * Bear/Base/Bull table exactly so the assumptions are auditable.
 */

export type Scenario = "bear" | "base" | "bull";

export interface Assumptions {
  llmCostPerCallUsd: number;
  callsPerDay: Record<Scenario, number>;
  infraCostPerMonthUsd: number;
  signalPriceUsd: number;
  riskCheckPriceUsd: number;
  integratorFeeBps: number;
  signalVolumePerDay: Record<Scenario, number>;
  riskCheckVolumePerDay: Record<Scenario, number>;
  followers: Record<Scenario, number>;
  avgCopiedOrderUsd: Record<Scenario, number>;
  tradesPerMonth: Record<Scenario, number>;
  outsideAumUsd: Record<Scenario, number>;
  outsideAumFeePctPerYear: number;
  keeperJobsPerMonth: Record<Scenario, number>;
  keeperNetBountyUsd: number;
  safeLegPrincipalUsd: number;
  safeLegApyPct: number;
  idleCushionUsd: number;
  idleCushionStablePoolAprPct: Record<Scenario, number>;
  tradingPnlUsd: Record<Scenario, number>;
}

export const PLANNING_ASSUMPTIONS: Assumptions = {
  llmCostPerCallUsd: 0.003,
  callsPerDay: { bear: 60, base: 40, bull: 40 },
  infraCostPerMonthUsd: 6,
  signalPriceUsd: 0.02,
  riskCheckPriceUsd: 0.005,
  integratorFeeBps: 20,
  signalVolumePerDay: { bear: 5, base: 20, bull: 100 },
  riskCheckVolumePerDay: { bear: 20, base: 100, bull: 500 },
  followers: { bear: 3, base: 10, bull: 50 },
  avgCopiedOrderUsd: { bear: 20, base: 30, bull: 100 },
  tradesPerMonth: { bear: 10, base: 20, bull: 30 },
  outsideAumUsd: { bear: 0, base: 5000, bull: 50000 },
  outsideAumFeePctPerYear: 1,
  keeperJobsPerMonth: { bear: 10, base: 30, bull: 60 },
  keeperNetBountyUsd: 0.2,
  safeLegPrincipalUsd: 900,
  safeLegApyPct: 4.5,
  idleCushionUsd: 100,
  idleCushionStablePoolAprPct: { bear: 3, base: 5, bull: 8 },
  tradingPnlUsd: { bear: -15, base: 0, bull: 15 },
};

export interface MonthlyEconomics {
  scenario: Scenario;
  engines: Record<string, number>;
  totalIncome: number;
  incomeWithoutTrading: number;
  burn: number;
  coverage: number; // income (without trading if trading is negative) / burn
}

export function monthly(s: Scenario, a: Assumptions = PLANNING_ASSUMPTIONS): MonthlyEconomics {
  const engines = {
    signals: a.signalVolumePerDay[s] * 30 * a.signalPriceUsd,
    risk_checks: a.riskCheckVolumePerDay[s] * 30 * a.riskCheckPriceUsd,
    copy_fees: a.followers[s] * a.avgCopiedOrderUsd[s] * a.tradesPerMonth[s] * (a.integratorFeeBps / 10_000),
    mgmt_fees: (a.outsideAumUsd[s] * (a.outsideAumFeePctPerYear / 100)) / 12,
    keeper: a.keeperJobsPerMonth[s] * a.keeperNetBountyUsd,
    lp: (a.idleCushionUsd * (a.idleCushionStablePoolAprPct[s] / 100)) / 12,
    yield: (a.safeLegPrincipalUsd * (a.safeLegApyPct / 100)) / 12,
    trading: a.tradingPnlUsd[s],
  };
  const incomeWithoutTrading = Object.entries(engines)
    .filter(([k]) => k !== "trading")
    .reduce((x, [, v]) => x + v, 0);
  const totalIncome = incomeWithoutTrading + engines.trading;
  const burn = a.callsPerDay[s] * 30 * a.llmCostPerCallUsd + a.infraCostPerMonthUsd;
  const coverage = (engines.trading < 0 ? incomeWithoutTrading : totalIncome) / burn;
  return { scenario: s, engines, totalIncome, incomeWithoutTrading, burn, coverage };
}

export function breakEven(burn: number, a: Assumptions = PLANNING_ASSUMPTIONS) {
  return {
    signalSalesPerDay: burn / (30 * a.signalPriceUsd),
    riskChecksPerDay: burn / (30 * a.riskCheckPriceUsd),
    copiedVolumePerMonthUsd: burn / (a.integratorFeeBps / 10_000),
    safeLegEndowmentUsd: (burn * 12) / (a.safeLegApyPct / 100),
  };
}

/**
 * Cost-plus management fee (Pillar 2). fee_per_cycle = attributable_compute_cost * (1 + margin).
 * Returns the annualised bps to push on-chain via PerpetuaVault.setFeeParams each cycle.
 */
export function costPlusMgmtFee(opts: {
  computeCostUsdPerCycle: number;
  followerAumUsd: number;
  cyclesPerYear: number;
  marginPct: number;
  capBps?: number;
}) {
  const feePerCycle = opts.computeCostUsdPerCycle * (1 + opts.marginPct / 100);
  const annual = feePerCycle * opts.cyclesPerYear;
  const bps = opts.followerAumUsd > 0 ? Math.ceil((annual / opts.followerAumUsd) * 10_000) : 0;
  const ownerProfitPerCycle = (feePerCycle * (opts.marginPct / 100)) / (1 + opts.marginPct / 100);
  return { feePerCycle, bps: Math.min(bps, opts.capBps ?? 300), ownerProfitPerCycle };
}
