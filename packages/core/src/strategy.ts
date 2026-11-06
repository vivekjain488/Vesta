/**
 * Signal engine. The LLM only scores sentiment and writes reasoning; the rules that open and size trades
 * are deterministic (this file). Spot-only (Flash): the agent is long or flat, never short.
 */
import { atr, donchian, ema, last, macd, percentileRank, rollingDailyVol, rsi, type Bar } from "./indicators";

export type Regime = "uptrend" | "range" | "downtrend";
/** adaptive = regime-switching ensemble: momentum in uptrends, mean-reversion in ranges, flat in downtrends. */
export type StrategyKind = "momentum" | "mean-reversion" | "dca" | "adaptive";
export const STRATEGY_KINDS: readonly StrategyKind[] = ["momentum", "mean-reversion", "dca", "adaptive"];

export interface MarketContext {
  asset: string;
  bars: Bar[]; // 4h bars, oldest first, >= 220 for EMA200
  btcBars?: Bar[];
  ethBars?: Bar[];
  fundingRate8h?: number; // decimal, e.g. 0.0001 = 1 bp
  sentiment?: { score: number; reasons: string[] } | null; // from 0G LLM; null in rules-only tiers
}

export interface FactorScores {
  trend: number;
  sentiment: number;
  momentum: number;
  relativeStrength: number;
  positioning: number;
}

export const FACTOR_WEIGHTS: FactorScores = {
  trend: 0.3,
  sentiment: 0.2,
  momentum: 0.2,
  relativeStrength: 0.15,
  positioning: 0.15,
};

export interface Signal {
  asset: string;
  direction: "long" | "flat";
  confidence: number; // 0..1, published and Brier-calibrated
  score: number; // weighted, -1..1
  regime: Regime;
  highVol: boolean;
  factors: FactorScores;
  agreeing: number;
  entry: number;
  stop: number;
  target: number;
  atrPct: number;
  rewardRisk: number;
  orderType: "market" | "limit";
  sizeMultiplier: number; // regime * vol
  reasons: string[];
  rejectedBy?: string;
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const slope = (series: number[], lookback: number) => {
  const a = series[series.length - 1 - lookback];
  const b = last(series);
  return a && b ? (b - a) / a : 0;
};

export function classifyRegime(bars: Bar[]) {
  const closes = bars.map((b) => b.c);
  const e50 = last(ema(closes, 50));
  const e200 = last(ema(closes, 200));
  const close = last(closes);
  let regime: Regime = "range";
  if (close > e200 && e50 > e200) regime = "uptrend";
  else if (close < e200 && e50 < e200) regime = "downtrend";
  // 30-day realised vol (180 x 4h bars) vs its own history: above the 90th percentile = high vol
  const vol = rollingDailyVol(closes, 180);
  const cur = last(vol);
  const highVol = !Number.isNaN(cur) && percentileRank(vol, cur) > 0.9;
  return { regime, highVol, ema50: e50, ema200: e200, dailyVol: Number.isNaN(cur) ? 0 : cur };
}

export function scoreFactors(ctx: MarketContext, breakoutBars = 20): FactorScores & { rsi: number } {
  const closes = ctx.bars.map((b) => b.c);
  const close = last(closes);
  // Trend: EMA20/50 slope + 20-bar Donchian breakout
  const s20 = Math.tanh(slope(ema(closes, 20), 5) * 25);
  const s50 = Math.tanh(slope(ema(closes, 50), 5) * 25);
  const dc = donchian(ctx.bars, breakoutBars);
  const breakout = close > last(dc.upper) ? 1 : close < last(dc.lower) ? -1 : 0;
  const trend = clamp(((s20 + s50) / 2) * 0.6 + breakout * 0.4);

  // Momentum: RSI(14) + MACD histogram
  const r = last(rsi(closes, 14));
  const rsiScore = r > 75 ? -0.5 : clamp((r - 50) / 25);
  const hist = last(macd(closes).hist);
  const macdScore = Number.isNaN(hist) ? 0 : Math.tanh((hist / close) * 200);
  const momentum = clamp(0.5 * rsiScore + 0.5 * macdScore);

  // Relative strength: asset/BTC and asset/ETH ratio trend
  const ratioScore = (other?: Bar[]) => {
    if (!other || other.length < ctx.bars.length) return 0;
    const o = other.slice(-ctx.bars.length);
    const ratio = closes.map((c, i) => c / o[i].c);
    return Math.tanh(slope(ema(ratio, 20), 10) * 20);
  };
  const rsBtc = ratioScore(ctx.btcBars);
  const rsEth = ratioScore(ctx.ethBars);
  const relativeStrength = clamp(ctx.asset === "ETH" ? rsBtc : (rsBtc + rsEth) / 2);

  // Positioning & flows: funding (crowding) + volume trend
  const vols = ctx.bars.map((b) => b.v);
  const v20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const v50 = vols.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const volScore = v50 > 0 ? Math.tanh((v20 / v50 - 1) * 2) : 0;
  const f = ctx.fundingRate8h ?? 0;
  const fundingScore = f > 0.0005 ? -0.6 : f > 0 ? 0.3 : f < -0.0002 ? 0.5 : 0.1;
  const positioning = clamp(0.5 * volScore * Math.sign(trend || 1) + 0.5 * fundingScore);

  const sentiment = clamp(ctx.sentiment?.score ?? 0);
  return { trend, sentiment, momentum, relativeStrength, positioning, rsi: r };
}

export interface SignalOptions {
  stopAtr?: number;
  targetAtr?: number;
  breakoutBars?: number;
  rsiOversold?: number;
  kind?: StrategyKind;
  minScore?: number; // 0.35
  minAgreeing?: number; // 3 of 5
  minRewardRisk?: number; // 2
  m?: number; // CPPI multiplier, stop must sit inside 1/m
  roundTripCostPct?: number; // Flash fee + gas + slippage, decimal
}

/** Everything the decision needs, computed only from bars up to and including the latest closed one. */
export interface SignalFeatures {
  asset: string;
  close: number;
  atr: number;
  regime: Regime;
  highVol: boolean;
  factors: FactorScores;
  rsi: number;
  sentimentReasons: string[];
}

export function signalFeatures(ctx: MarketContext, breakoutBars?: number): SignalFeatures {
  const close = last(ctx.bars.map((b) => b.c));
  const { regime, highVol } = classifyRegime(ctx.bars);
  const f = scoreFactors(ctx, breakoutBars);
  return {
    asset: ctx.asset,
    close,
    atr: last(atr(ctx.bars, 14)),
    regime,
    highVol,
    factors: { trend: f.trend, sentiment: f.sentiment, momentum: f.momentum, relativeStrength: f.relativeStrength, positioning: f.positioning },
    rsi: f.rsi,
    sentimentReasons: ctx.sentiment?.reasons ?? [],
  };
}

export function generateSignal(ctx: MarketContext, opts: SignalOptions = {}): Signal {
  return decideSignal(signalFeatures(ctx, opts.breakoutBars), opts);
}

/** Deterministic entry rules. Shared verbatim by the live agent and the backtester. */
export function decideSignal(x: SignalFeatures, opts: SignalOptions = {}): Signal {
  const kind = opts.kind ?? "momentum";
  const minScore = opts.minScore ?? 0.35;
  const minAgree = opts.minAgreeing ?? 3;
  const minRR = opts.minRewardRisk ?? 2;
  const m = opts.m ?? 3;
  const cost = opts.roundTripCostPct ?? 0.004;

  const { close, regime, highVol, factors } = x;
  const a = x.atr;
  const score = (Object.keys(FACTOR_WEIGHTS) as (keyof FactorScores)[]).reduce(
    (s, k) => s + FACTOR_WEIGHTS[k] * factors[k],
    0,
  );
  const agreeing = Object.values(factors).filter((v) => v > 0).length;

  const stop = close - (opts.stopAtr ?? 2) * a;
  const target = close + (opts.targetAtr ?? 4) * a;
  const rewardRisk = (target - close) / (close - stop);
  const atrPct = a / close;
  const regimeMult = regime === "uptrend" ? 1 : regime === "range" ? 0.5 : 0;
  const sizeMultiplier = regimeMult * (highVol ? 0.5 : 1);
  const reasons: string[] = [
    `regime=${regime}${highVol ? " (high vol: size halved)" : ""}`,
    `score=${score.toFixed(3)} agreeing=${agreeing}/5 rsi=${x.rsi.toFixed(1)}`,
    ...x.sentimentReasons,
  ];

  const base: Signal = {
    asset: x.asset,
    direction: "flat",
    confidence: Math.max(0, Math.min(1, (score + 1) / 2)),
    score,
    regime,
    highVol,
    factors,
    agreeing,
    entry: close,
    stop,
    target,
    atrPct,
    rewardRisk,
    orderType: regime === "range" ? "limit" : "market",
    sizeMultiplier,
    reasons,
  };
  const reject = (why: string): Signal => ({ ...base, rejectedBy: why });

  if (!Number.isFinite(a) || a <= 0) return reject("insufficient data");
  if (regime === "downtrend") return reject("downtrend: no new longs");
  if ((close - stop) / close >= 1 / m) return reject("stop outside CPPI gap 1/m");
  if ((target - close) / close < 3 * cost) return reject("expected move < 3x round-trip cost");
  if (rewardRisk < minRR) return reject(`reward:risk < ${minRR}`);

  if (kind === "dca") {
    // Accumulator: buys on schedule in non-downtrend regimes, smaller size, still bracketed.
    return { ...base, direction: "long", orderType: "limit", sizeMultiplier: sizeMultiplier * 0.5 };
  }
  const meanReversion = (): Signal => {
    if (regime !== "range") return reject("mean-reversion trades range regimes only");
    if (x.rsi > (opts.rsiOversold ?? 40)) return reject("mean-reversion: rsi not oversold");
    return { ...base, direction: "long", orderType: "limit", entry: close - 0.5 * a };
  };
  const momentum = (): Signal => {
    if (x.rsi > 75) return reject("rsi > 75: no chasing");
    if (regime === "range") return reject("momentum: range regime is mean-reversion only");
    if (score < minScore) return reject(`score ${score.toFixed(2)} < ${minScore}`);
    if (agreeing < minAgree) return reject(`only ${agreeing}/5 factors agree`);
    return { ...base, direction: "long" };
  };
  if (kind === "mean-reversion") return meanReversion();
  if (kind === "adaptive") {
    // Regime switch: each sub-strategy only runs in the regime it was built for.
    const s = regime === "range" ? meanReversion() : momentum();
    return { ...s, reasons: [`adaptive -> ${regime === "range" ? "mean-reversion" : "momentum"}`, ...s.reasons] };
  }
  return momentum();
}

export interface SizingInput {
  cushionUsd: number;
  exposureBudgetUsd: number; // E
  openExposureUsd: number;
  stopDistancePct: number; // decimal
  sizeMultiplier: number;
  liveTrades: number;
  kellyFraction?: number; // f* from the backtest once >= 30 live trades
  halfSize?: boolean; // 3 losses in a row
}

/** 10%-of-cushion risk rule until 30 live trades, then (fractional) Kelly. Shared budget E across assets. */
export function sizePosition(s: SizingInput): number {
  const riskFrac = s.liveTrades >= 30 && s.kellyFraction ? Math.min(s.kellyFraction / 2, 0.25) : 0.1;
  const risk = s.cushionUsd * riskFrac;
  let size = s.stopDistancePct > 0 ? risk / s.stopDistancePct : 0;
  size *= s.sizeMultiplier;
  if (s.halfSize) size /= 2;
  const room = Math.max(0, s.exposureBudgetUsd - s.openExposureUsd);
  return Math.max(0, Math.min(size, room));
}
