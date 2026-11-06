/**
 * Walk-forward tuning of the three risk-tier presets on real BTC/ETH 4h candles (Binance spot).
 *
 *   pnpm optimize:presets               # 5 years, cached under .perpetua/history
 *   pnpm optimize:presets -- --refresh  # re-download candles
 *
 * Procedure (per tier, honest by construction):
 *  1. Roll a 2-year training window forward in 6-month steps. In each window, grid-search the rule parameters,
 *     discarding any set whose training drawdown breaks the tier's cap or that trades too rarely.
 *  2. Trade the NEXT 6 months (never seen during that fit) with the winner. Stitch those test periods into one
 *     continuous out-of-sample equity curve: that is the number the UI shows.
 *  3. Ship the parameters fitted on the most recent 2 years. Their in-sample result is reported separately and
 *     labelled as such.
 * Costs: 0.4% round trip on every trade. Sentiment is excluded (rules only), so live entries can only be rarer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  alignBars, computeFeatureSeries, simulate, TIER_PROFILES, BACKTEST_WARMUP,
  type Bar, type BacktestParams, type BacktestStats, type FeatureSeries, type PresetTuningFile, type RiskTierId, type StrategyKind, type TierTuning,
} from "@perpetua/core";
import { fetchHistory4h } from "../agent/src/market";

const root = resolve(new URL("..", import.meta.url).pathname);
const BARS = Number(process.argv.find((a) => a.startsWith("--bars="))?.split("=")[1] ?? 10_950); // ~5 years
const TRAIN = 4380; // 2 years of 4h bars
const TEST = 1095; // ~6 months
const COST = 0.004;
const MIN_TRAIN_TRADES = 10;
const LAMBDA: Record<RiskTierId, number> = { conservative: 1, balanced: 0.5, aggressive: 0.25 };

async function history(symbol: string): Promise<Bar[]> {
  const dir = resolve(root, ".perpetua/history");
  const file = resolve(dir, `${symbol}-4h.json`);
  if (!process.argv.includes("--refresh") && existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8")) as Bar[];
    if (cached.length >= BARS) return cached.slice(-BARS);
  }
  const now = Math.floor(Date.now() / 1000);
  const bars = (await fetchHistory4h(symbol, BARS + 2)).filter((b) => b.t + 14_400 <= now).slice(-BARS); // closed candles only
  if (bars.length < TRAIN + TEST + BACKTEST_WARMUP) throw new Error(`not enough ${symbol} history (${bars.length} bars)`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(bars));
  return bars;
}

type Signal = BacktestParams["signal"];
function grid(): { kind: StrategyKind; signal: Signal }[] {
  const out: { kind: StrategyKind; signal: Signal }[] = [];
  const stops = [1.5, 2, 2.5, 3];
  const ratios = [2, 3, 4, 5];
  for (const stopAtr of stops) for (const rr of ratios) {
    const base = { stopAtr, targetAtr: Math.round(stopAtr * rr * 100) / 100, minRewardRisk: 2 };
    for (const breakoutBars of [20, 55]) for (const minScore of [0.15, 0.25, 0.35]) for (const minAgreeing of [2, 3]) {
      out.push({ kind: "momentum", signal: { ...base, breakoutBars, minScore, minAgreeing, rsiOversold: 35 } });
      for (const rsiOversold of [30, 35, 40]) out.push({ kind: "adaptive", signal: { ...base, breakoutBars, minScore, minAgreeing, rsiOversold } });
    }
    for (const rsiOversold of [30, 35, 40]) out.push({ kind: "mean-reversion", signal: { ...base, breakoutBars: 20, minScore: 0.35, minAgreeing: 3, rsiOversold } });
    out.push({ kind: "dca", signal: { ...base, breakoutBars: 20, minScore: 0.35, minAgreeing: 3, rsiOversold: 35 } });
  }
  return out;
}

function params(tier: RiskTierId, c: { kind: StrategyKind; signal: Signal }): BacktestParams {
  const p = TIER_PROFILES[tier];
  return { kind: c.kind, signal: c.signal, piBps: p.piBps, multiplier: p.multiplier, riskPerTradePct: p.riskPerTradePct, maxMarginPct: p.maxMarginPct, roundTripCostPct: COST };
}

function fit(series: FeatureSeries[], tier: RiskTierId, from: number, to: number) {
  const cap = TIER_PROFILES[tier].drawdownCapPct;
  let best: { c: { kind: StrategyKind; signal: Signal }; s: BacktestStats; score: number } | null = null;
  let safest: typeof best = null;
  for (const c of grid()) {
    const s = simulate(series, () => params(tier, c), from, to).stats;
    const score = s.totalReturnPct - LAMBDA[tier] * s.maxDrawdownPct;
    if (!safest || s.maxDrawdownPct < safest.s.maxDrawdownPct) safest = { c, s, score };
    if (s.maxDrawdownPct > cap || s.trades < MIN_TRAIN_TRADES) continue;
    if (!best || score > best.score) best = { c, s, score };
  }
  return (best ?? safest)!;
}

const [btcRaw, ethRaw] = await Promise.all([history("BTCUSDT"), history("ETHUSDT")]);
const [btc, eth] = alignBars(btcRaw, ethRaw);
console.log(`candles: ${btc.length} aligned 4h bars, ${new Date(btc[0].t * 1000).toISOString().slice(0, 10)} -> ${new Date(btc[btc.length - 1].t * 1000).toISOString().slice(0, 10)}`);
const t0 = Date.now();
const series = [computeFeatureSeries("BTC", btc, { btc, eth }, [20, 55]), computeFeatureSeries("ETH", eth, { btc, eth }, [20, 55])];
console.log(`features computed in ${((Date.now() - t0) / 1000).toFixed(1)}s; grid = ${grid().length} parameter sets per fit`);

const n = btc.length;
const folds: { trainFrom: number; trainTo: number; testTo: number }[] = [];
for (let trainFrom = n - TRAIN - TEST; trainFrom >= BACKTEST_WARMUP; trainFrom -= TEST) folds.unshift({ trainFrom, trainTo: trainFrom + TRAIN, testTo: trainFrom + TRAIN + TEST });
const day = (i: number) => new Date(btc[Math.min(i, n - 1)].t * 1000).toISOString().slice(0, 10);

const tiers = {} as Record<RiskTierId, TierTuning>;
const detail: Record<string, unknown> = {};
for (const tier of ["conservative", "balanced", "aggressive"] as const) {
  const chosen = folds.map((f) => ({ f, best: fit(series, tier, f.trainFrom, f.trainTo) }));
  const oosFrom = folds[0].trainTo;
  const oosTo = folds[folds.length - 1].testTo;
  const at = (i: number) => params(tier, (chosen.find((c) => i >= c.f.trainTo && i < c.f.testTo) ?? chosen[chosen.length - 1]).best.c);
  const walkForward = simulate(series, at, oosFrom, oosTo).stats;
  const final = fit(series, tier, n - TRAIN, n);
  const foldRows = chosen.map(({ f, best }) => {
    const s = simulate(series, () => params(tier, best.c), f.trainTo, f.testTo).stats;
    return { trainFrom: day(f.trainFrom), trainTo: day(f.trainTo - 1), testFrom: day(f.trainTo), testTo: day(f.testTo - 1), kind: best.c.kind, testReturnPct: s.totalReturnPct, testMaxDrawdownPct: s.maxDrawdownPct, testTrades: s.trades };
  });
  tiers[tier] = { kind: final.c.kind, parameters: { ...final.c.signal }, walkForward, inSample: final.s, folds: foldRows };
  detail[tier] = { folds: chosen.map(({ f, best }) => ({ train: [day(f.trainFrom), day(f.trainTo - 1)], test: [day(f.trainTo), day(f.testTo - 1)], chosen: best.c, train_stats: best.s })), shipped: final.c, inSample: final.s, walkForward };
  console.log(`\n${tier}: ships ${final.c.kind} ${JSON.stringify(final.c.signal)}`);
  console.table(foldRows);
  console.table({ "walk-forward (out-of-sample)": walkForward, "shipped params (in-sample)": final.s });
}

const out: PresetTuningFile = {
  generatedAt: new Date().toISOString(),
  dataSource: "Binance spot BTCUSDT/ETHUSDT 4h candles (closed bars only)",
  method: `Walk-forward: ${TRAIN / 2190}y train / ${Math.round(TEST / 182.5)}mo test, rolled ${folds.length}x; grid of ${grid().length} rule sets; per-tier drawdown cap; ${COST * 100}% round-trip cost; rules only (no sentiment)`,
  costRoundTripPct: COST * 100,
  tiers,
};
writeFileSync(resolve(root, "packages/core/src/presets.generated.ts"), `// AUTO-GENERATED by scripts/optimize-presets.ts on ${out.generatedAt}. Do not edit.\nimport type { PresetTuningFile } from "./presets";\n\nexport const PRESET_TUNING: PresetTuningFile = ${JSON.stringify(out, null, 2)};\n`);
mkdirSync(resolve(root, ".perpetua"), { recursive: true });
writeFileSync(resolve(root, ".perpetua/preset-optimization.json"), JSON.stringify({ ...out, detail }, null, 2));
console.log("\nwrote packages/core/src/presets.generated.ts and .perpetua/preset-optimization.json");
