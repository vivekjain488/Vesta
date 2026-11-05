import { describe, expect, it } from "vitest";
import {
  breakEven,
  checkEntry,
  computeMandate,
  costPlusMgmtFee,
  ema,
  generateSignal,
  monthly,
  pickModel,
  rankAgents,
  rsi,
  runwayHours,
  scoreAgent,
  shouldWake,
  sizePosition,
  SpendCap,
  tierFor,
  valueAtRisk,
  type Bar,
} from "../src";

describe("CPPI mirror of CPPIMath.sol", () => {
  it("reproduces the worked example", () => {
    const m = computeMandate({ V: 1000_000000n, P: 1000_000000n, piBps: 9500n, R: 10_000000n, m: 3n, eMax: 250_000000n });
    expect(m).toEqual({ F: 960_000000n, C: 40_000000n, E: 120_000000n });
  });
  it("VaR example", () => expect(valueAtRisk(150_000000n, 500n)).toBe(12_375000n));
  it("risk check mirrors RiskGate.checkOrder", () => {
    const base = {
      mandate: { F: 960_000000n, C: 40_000000n, E: 120_000000n, validUntil: 2000 },
      m: 3n,
      openExposure: 0n,
      order: {
        amountIn: 50_000000n,
        minAmountOut: (50_000000n * 10n ** 20n) / 15_00000000n,
        assetDecimals: 18,
        stopPriceE8: 13_80000000n,
        deadline: 1500,
        recipient: "0xabc",
        expectedRecipient: "0xABC",
        assetAllowed: true,
      },
      price: { priceE8: 15_00000000n, timestamp: 1000 },
      dailyVolBps: 500n,
      now: 1010,
    };
    expect(checkEntry(base)).toBe("OK");
    expect(checkEntry({ ...base, order: { ...base.order, amountIn: 500_000000n, minAmountOut: (500_000000n * 10n ** 20n) / 15_00000000n } })).toBe("EXCEEDS_EXPOSURE");
    expect(checkEntry({ ...base, order: { ...base.order, stopPriceE8: 0n } })).toBe("NO_STOP");
    expect(checkEntry({ ...base, order: { ...base.order, stopPriceE8: 9_00000000n } })).toBe("STOP_OUTSIDE_GAP");
    expect(checkEntry({ ...base, now: 1061 })).toBe("PRICE_STALE");
    expect(checkEntry({ ...base, order: { ...base.order, recipient: "0xdead" } })).toBe("RECIPIENT_NOT_WALLET");
  });
});

describe("unit economics reproduce the spec table", () => {
  it("bear/base/bull", () => {
    expect(monthly("bear").totalIncome).toBeCloseTo(-2.175, 3); // spec table rounds to -2.17
    expect(monthly("bear").incomeWithoutTrading).toBeCloseTo(12.825, 3); // spec rounds to 12.83
    expect(monthly("bear").burn).toBeCloseTo(11.4, 2);
    expect(monthly("base").totalIncome).toBeCloseTo(52.96, 2);
    expect(monthly("base").burn).toBeCloseTo(9.6, 2);
    expect(monthly("base").coverage).toBeCloseTo(5.5, 1);
    expect(monthly("bull").totalIncome).toBeCloseTo(507.71, 2);
    expect(monthly("bull").incomeWithoutTrading).toBeCloseTo(492.71, 2);
  });
  it("break-even at $9.60/month burn", () => {
    const b = breakEven(9.6);
    expect(b.signalSalesPerDay).toBeCloseTo(16);
    expect(b.riskChecksPerDay).toBeCloseTo(64);
    expect(b.copiedVolumePerMonthUsd).toBeCloseTo(4800);
    expect(b.safeLegEndowmentUsd).toBeCloseTo(2560);
  });
  it("cost-plus fee: owner profit = fee * margin / (1 + margin)", () => {
    const f = costPlusMgmtFee({ computeCostUsdPerCycle: 1, followerAumUsd: 100_000, cyclesPerYear: 2190, marginPct: 25 });
    expect(f.feePerCycle).toBeCloseTo(1.25);
    expect(f.ownerProfitPerCycle).toBeCloseTo(0.25);
  });
});

describe("position sizing", () => {
  it("worked example: $50 cushion, 4% ATR -> 8% stop -> $62.50", () => {
    expect(
      sizePosition({ cushionUsd: 50, exposureBudgetUsd: 150, openExposureUsd: 0, stopDistancePct: 0.08, sizeMultiplier: 1, liveTrades: 0 }),
    ).toBeCloseTo(62.5);
  });
  it("shared exposure budget caps size", () => {
    expect(
      sizePosition({ cushionUsd: 50, exposureBudgetUsd: 150, openExposureUsd: 120, stopDistancePct: 0.08, sizeMultiplier: 1, liveTrades: 0 }),
    ).toBeCloseTo(30);
  });
});

describe("degradation ladder + router", () => {
  it("tiers by runway", () => {
    expect(tierFor(8 * 24).tier).toBe("thrive");
    expect(tierFor(3 * 24).tier).toBe("frugal");
    expect(tierFor(20).tier).toBe("starving");
    expect(tierFor(6).tier).toBe("hibernate");
  });
  it("reserve only counts below frugal", () => {
    expect(runwayHours({ ledgerBalanceOg: 10, reserveOg: 4, burnOgPerHour: 1 })).toBe(6);
    expect(runwayHours({ ledgerBalanceOg: 10, reserveOg: 4, burnOgPerHour: 1, includeReserve: true })).toBe(10);
  });
  it("never spends $0.50 deciding something worth $2", () => {
    const models = [
      { id: "small", tier: "small" as const, estCostUsdPerCall: 0.001 },
      { id: "large", tier: "large" as const, estCostUsdPerCall: 0.5 },
    ];
    expect(pickModel({ decision: "trade_proposal", exposureUsd: 2, policy: tierFor(1000), models })?.id).toBe("small");
    expect(pickModel({ decision: "trade_proposal", exposureUsd: 100, policy: tierFor(1000), models })?.id).toBe("large");
    expect(pickModel({ decision: "trade_proposal", exposureUsd: 100, policy: tierFor(20), models })).toBeNull();
  });
  it("spend cap", () => {
    const c = new SpendCap(1000, 5000);
    expect(c.canSpend(900, 0)).toBe(true);
    c.record(900, 0);
    expect(c.canSpend(200, 10)).toBe(false);
    expect(c.canSpend(200, 3700)).toBe(true);
  });
  it("wake filter", () => {
    expect(shouldWake({ newBarClosed: false, volSpike: false, crossedLevel: false, mandateChanged: false, hoursSinceLastThought: 1 }).wake).toBe(false);
    expect(shouldWake({ newBarClosed: true, volSpike: false, crossedLevel: false, mandateChanged: false, hoursSinceLastThought: 4 }).wake).toBe(true);
  });
});

function synthBars(n: number, drift: number, seed = 1): Bar[] {
  let x = seed;
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647) - 0.5;
  const bars: Bar[] = [];
  let p = 10;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + drift + rand() * 0.02);
    bars.push({ t: i * 14400, o, h: Math.max(o, p) * 1.005, l: Math.min(o, p) * 0.995, c: p, v: 1000 + rand() * 100 });
  }
  return bars;
}

describe("indicators + signal engine", () => {
  it("ema/rsi sane", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(ema(xs, 10).at(-1)).toBeGreaterThan(40);
    expect(rsi(xs, 14).at(-1)).toBe(100);
  });
  it("no longs in a downtrend", () => {
    const s = generateSignal({ asset: "LINK", bars: synthBars(300, -0.004) });
    expect(s.direction).toBe("flat");
    expect(s.regime).toBe("downtrend");
  });
  it("brackets: stop 2x ATR, target 4x ATR => R:R 2", () => {
    const s = generateSignal({ asset: "LINK", bars: synthBars(300, 0.003), sentiment: { score: 0.6, reasons: [] } });
    expect(s.rewardRisk).toBeCloseTo(2);
    expect(s.stop).toBeLessThan(s.entry);
  });
});

describe("leaderboard", () => {
  const now = 200 * 86400;
  const days = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ t: now - (n - i) * 86400, r: f(i) }));
  it("geometric score punishes a hidden blow-up and bad calibration", () => {
    const steady = { agent: "steady", tier: "balanced" as const, returns: days(120, (i) => (i % 5 === 0 ? -0.002 : 0.003)), outcomes: Array(40).fill({ p: 0.6, o: 1 }), decisions: 50, verifiedDecisions: 50, firstSeen: now - 120 * 86400, lastSettledTrade: now - 86400 };
    const blowup = { ...steady, agent: "blowup", returns: days(120, (i) => (i === 100 ? -0.4 : 0.006)), outcomes: Array(40).fill({ p: 0.9, o: 0 }) };
    const r = rankAgents([blowup, steady], now);
    expect(r.crossTier[0].agent).toBe("steady");
  });
  it("new agents are damped and flagged unverified", () => {
    const s = scoreAgent({ agent: "new", tier: "aggressive", returns: days(5, () => 0.01), outcomes: [], decisions: 3, verifiedDecisions: 3, firstSeen: now - 5 * 86400, lastSettledTrade: now }, now);
    expect(s.unverified).toBe(true);
    expect(s.trackFactor).toBeLessThan(0.3);
  });
  it("going quiet decays the score", () => {
    const base = { agent: "q", tier: "balanced" as const, returns: days(100, () => 0.002), outcomes: [], decisions: 10, verifiedDecisions: 10, firstSeen: now - 100 * 86400 };
    const active = scoreAgent({ ...base, lastSettledTrade: now }, now).score;
    const idle = scoreAgent({ ...base, lastSettledTrade: now - 60 * 86400 }, now).score;
    expect(idle).toBeLessThan(active / 4);
  });
});
