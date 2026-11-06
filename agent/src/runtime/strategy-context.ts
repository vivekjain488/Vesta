import type { StrategyConfig } from "@perpetua/core";

/** Numerical observations, not trading decisions. Only closed bars may be supplied. */
export function strategyContext(template: StrategyConfig["template"], input: unknown, now: number) {
  if (!Array.isArray(input)) return { available: false, reason: "recent closed minute candles unavailable" };
  const bars = input.map((b: any) => ({
    t: Number(b.t ?? b.openTime), o: Number(b.o ?? b.open), h: Number(b.h ?? b.high), l: Number(b.l ?? b.low), c: Number(b.c ?? b.close),
  }));
  if (bars.length < 6 || bars.some((b, i) => !Number.isSafeInteger(b.t) || b.t % 60000 !== 0 || b.t + 60000 > now || [b.o,b.h,b.l,b.c].some((x) => !Number.isFinite(x) || x <= 0) || b.l > Math.min(b.o,b.c) || b.h < Math.max(b.o,b.c) || (i > 0 && b.t - bars[i-1].t !== 60000))) return { available: false, reason: "invalid or incomplete recent minute candles" };
  const recent = bars.slice(-15), closes = recent.map((b) => b.c), last = closes.at(-1)!;
  const mean = closes.reduce((a,b) => a+b, 0) / closes.length;
  const prior = recent.slice(0,-1), high = Math.max(...prior.map((b) => b.h)), low = Math.min(...prior.map((b) => b.l));
  const pct = (a: number, b: number) => (a / b - 1) * 100;
  const common = { available: true, timeframe: "closed 1m bars", bars: recent.length, lastClose: last, lastCloseAtMs: recent.at(-1)!.t + 60000, change1mPct: pct(last, closes.at(-2)!), change5mPct: pct(last, closes.at(-6)!) };
  if (template.endsWith("range") || template === "spot-bollinger" || template === "spot-rsi-recovery") return { ...common, focus: "range and mean reversion", mean, deviationFromMeanPct: pct(last, mean), priorRangeHigh: high, priorRangeLow: low, rangePositionPct: high === low ? null : (last-low)/(high-low)*100 };
  if (template === "spot-dca") return { ...common, focus: "accumulation and pullback", mean, deviationFromMeanPct: pct(last, mean), pullbackFromPriorHighPct: pct(last, high) };
  return { ...common, focus: "momentum and breakout", priorRangeHigh: high, priorRangeLow: low, distanceFromPriorHighPct: pct(last, high), distanceFromPriorLowPct: pct(last, low) };
}
