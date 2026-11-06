import { donchian, ema, rsi, type Bar } from "./indicators";

export type ResearchStrategy = "breakout" | "bollinger" | "rsi-recovery";
export interface StrategySetup { strategy: ResearchStrategy; available: boolean; entry: boolean; exit: boolean; observations: Record<string, number | string | null>; }

/** Closed-bar setups only. These are strategy evidence, not orders or forecasts. */
export function researchSetup(strategy: ResearchStrategy, bars: Bar[], breakoutBars = 20, oversold = 35): StrategySetup {
  const unavailable = (): StrategySetup => ({ strategy, available: false, entry: false, exit: false, observations: { reason: "insufficient or invalid closed bars" } });
  if (!Number.isInteger(breakoutBars) || breakoutBars < 2 || !Number.isFinite(oversold) || oversold < 0 || oversold > 100 || bars.length < Math.max(22, strategy === "breakout" ? breakoutBars + 1 : 22) || bars.some((b, i) => !Number.isSafeInteger(b.t) || [b.o,b.h,b.l,b.c,b.v].some((n) => !Number.isFinite(n)) || Math.min(b.o,b.h,b.l,b.c) <= 0 || b.v < 0 || b.l > Math.min(b.o,b.c) || b.h < Math.max(b.o,b.c) || (i > 0 && b.t <= bars[i-1].t))) return unavailable();
  const closes = bars.map((b) => b.c), close = closes.at(-1)!, previous = closes.at(-2)!;
  if (strategy === "breakout") {
    const high = donchian(bars, breakoutBars).upper.at(-1)!;
    const low = donchian(bars, 10).lower.at(-1)!;
    return { strategy, available: true, entry: close > high, exit: close < low, observations: { close, previousHigh: high, previousTenBarLow: low, entryLookback: breakoutBars } };
  }
  if (strategy === "bollinger") {
    const band = (values: number[]) => { const mean = values.reduce((a,b) => a+b,0)/values.length; const deviation = Math.sqrt(values.reduce((sum,x) => sum+(x-mean)**2,0)/values.length); return { mean, lower: mean-2*deviation }; };
    const current = band(closes.slice(-20)), prior = band(closes.slice(-21,-1));
    return { strategy, available: true, entry: previous < prior.lower && close >= current.lower && close < current.mean, exit: close >= current.mean, observations: { close, previous, mean: current.mean, lowerBand: current.lower, previousLowerBand: prior.lower } };
  }
  const values = rsi(closes, 14), currentRsi = values.at(-1)!, previousRsi = values.at(-2)!, trendEma = ema(closes, 20).at(-1)!;
  if (![currentRsi, previousRsi, trendEma].every(Number.isFinite)) return unavailable();
  return { strategy, available: true, entry: previousRsi < oversold && currentRsi >= oversold, exit: currentRsi >= 70, observations: { close, previousRsi, currentRsi, oversold, trendEma } };
}
