/**
 * Portfolio backtester for the deterministic rules, shared by the preset optimizer and tests.
 *
 * Faithful to the live path where it matters:
 *  - the SAME decision function as the agent (`decideSignal`), fed features computed from closed bars only;
 *  - decisions at a bar's close, fills at the next bar's open (limit entries fill only if the next bar trades
 *    through the limit, at the better of open/limit);
 *  - Flash-style brackets at the signal's absolute stop/target; when one bar spans both, the STOP fills first,
 *    and a gap through the stop fills at the open;
 *  - CPPI sizing: floor F = pi * principal, cushion C = max(V - F, 0), exposure budget E = m * C shared across
 *    assets, 10%-of-cushion risk rule (`sizePosition`), the strategy's per-trade risk and margin caps, and the
 *    RiskGate 1-day VaR check (1.65 * dailyVol * exposure <= C);
 *  - round-trip cost charged on every trade.
 * Not modelled (all disclosed with results): LLM sentiment (factor = 0), funding-rate positioning, safe-leg
 * yield on idle capital, intraday breaker halts, Kelly sizing after 30 live trades.
 */
import type { Bar } from "./indicators";
import { decideSignal, signalFeatures, sizePosition, type SignalFeatures, type SignalOptions, type StrategyKind } from "./strategy";

export interface FeatureSeries {
  asset: string;
  bars: Bar[];
  /** features[breakoutBars][i] for bar i (null during warm-up). */
  features: Record<number, (SignalFeatures | null)[]>;
}

const WINDOW = 400;
export const BACKTEST_WARMUP = 220;

/** Precompute features once per breakout length; every parameter set then reuses them. */
export function computeFeatureSeries(asset: string, bars: Bar[], refs: { btc?: Bar[]; eth?: Bar[] }, breakouts: number[]): FeatureSeries {
  const features: FeatureSeries["features"] = {};
  for (const b of breakouts) features[b] = new Array(bars.length).fill(null);
  for (let i = BACKTEST_WARMUP; i < bars.length; i++) {
    const from = Math.max(0, i + 1 - WINDOW);
    const window = bars.slice(from, i + 1);
    const align = (o?: Bar[]) => (o && o.length === bars.length ? o.slice(from, i + 1) : undefined);
    const ctx = { asset, bars: window, btcBars: align(refs.btc), ethBars: align(refs.eth), sentiment: null };
    for (const b of breakouts) features[b][i] = signalFeatures(ctx, b);
  }
  return { asset, bars, features };
}

export interface TierRisk {
  /** CPPI protection level in bps of principal (9700 = 97% floor). */
  piBps: number;
  /** CPPI multiplier m: exposure budget E = m * cushion. */
  multiplier: number;
  riskPerTradePct: number;
  maxMarginPct: number;
}

export interface BacktestParams extends TierRisk {
  kind: StrategyKind;
  signal: Required<Pick<SignalOptions, "minScore" | "minAgreeing" | "minRewardRisk" | "stopAtr" | "targetAtr" | "breakoutBars" | "rsiOversold">>;
  roundTripCostPct: number;
  /** RiskGate asset daily vol used by the on-chain VaR check (bps). */
  dailyVolBps?: number;
}

export interface SimTrade {
  asset: string;
  entryT: number;
  exitT: number;
  entry: number;
  exit: number;
  /** notional as a fraction of portfolio value at entry */
  sizeFrac: number;
  /** P&L as a fraction of the starting principal */
  pnl: number;
  r: number;
  reason: "stop" | "target" | "open";
}

export interface BacktestStats {
  from: string;
  to: string;
  years: number;
  trades: number;
  winRate: number;
  avgR: number;
  profitFactor: number | null;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  exposurePct: number;
  floorHeld: boolean;
  /** 50/50 BTC/ETH buy-and-hold over the same bars, for context only */
  buyHoldPct: number;
}

interface Position {
  asset: number;
  entryT: number;
  entry: number;
  stop: number;
  target: number;
  qty: number; // units of the asset, scaled to principal = 1
  sizeFrac: number;
}

/** Simulate bars [from, to) of aligned series. `paramsAt(i)` lets walk-forward switch parameters per fold. */
export function simulate(series: FeatureSeries[], paramsAt: (i: number) => BacktestParams, from: number, to: number) {
  const n = series[0].bars.length;
  to = Math.min(to, n);
  from = Math.max(from, BACKTEST_WARMUP);
  let cash = 1; // principal = 1; floor is fixed relative to it
  const open: Position[] = [];
  const pending: (null | { kind: "market" | "limit"; price: number; stop: number; target: number; notional: number })[] = series.map(() => null);
  const trades: SimTrade[] = [];
  const equity: number[] = [];
  let exposedBars = 0;
  let minEquity = 1;

  const markValue = (i: number) => cash + open.reduce((s, p) => s + p.qty * series[p.asset].bars[i].c, 0);
  const close = (p: Position, exitPrice: number, t: number, reason: SimTrade["reason"], cost: number) => {
    const notional = p.qty * p.entry;
    const proceeds = p.qty * exitPrice;
    cash += proceeds - cost * notional;
    const pnl = proceeds - notional - cost * notional;
    trades.push({ asset: series[p.asset].asset, entryT: p.entryT, exitT: t, entry: p.entry, exit: exitPrice, sizeFrac: p.sizeFrac, pnl, r: pnl / Math.max(1e-12, p.qty * (p.entry - p.stop)), reason });
    open.splice(open.indexOf(p), 1);
  };

  for (let i = from; i < to; i++) {
    const params = paramsAt(i);
    // 1. fills for orders decided at the previous close
    for (let a = 0; a < series.length; a++) {
      const o = pending[a];
      if (!o) continue;
      pending[a] = null;
      const bar = series[a].bars[i];
      const fill = o.kind === "market" ? bar.o : bar.l <= o.price ? Math.min(bar.o, o.price) : NaN;
      if (!Number.isFinite(fill) || fill <= o.stop || fill >= o.target) continue;
      const qty = o.notional / fill;
      cash -= o.notional;
      open.push({ asset: a, entryT: bar.t, entry: fill, stop: o.stop, target: o.target, qty, sizeFrac: o.notional / Math.max(1e-12, markValue(i - 1)) });
    }
    // 2. bracket exits on this bar (stop first)
    for (const p of [...open]) {
      const bar = series[p.asset].bars[i];
      if (bar.l <= p.stop) close(p, Math.min(p.stop, bar.o), bar.t, "stop", params.roundTripCostPct);
      else if (bar.h >= p.target) close(p, Math.max(p.target, bar.o), bar.t, "target", params.roundTripCostPct);
    }
    // 3. decisions at this bar's close for flat assets
    const V = markValue(i);
    const F = params.piBps / 10_000;
    const C = Math.max(0, V - F);
    const E = params.multiplier * C;
    for (let a = 0; a < series.length; a++) {
      if (i + 1 >= to || open.some((p) => p.asset === a) || pending[a]) continue;
      const feat = series[a].features[params.signal.breakoutBars]?.[i];
      if (!feat) continue;
      const s = decideSignal(feat, { kind: params.kind, m: params.multiplier, roundTripCostPct: params.roundTripCostPct, ...params.signal });
      if (s.direction !== "long") continue;
      const stopPct = (s.entry - s.stop) / s.entry;
      const openNotional = open.reduce((x, p) => x + p.qty * series[p.asset].bars[i].c, 0) + pending.reduce((x, o) => x + (o?.notional ?? 0), 0);
      let size = sizePosition({ cushionUsd: C, exposureBudgetUsd: E, openExposureUsd: openNotional, stopDistancePct: stopPct, sizeMultiplier: s.sizeMultiplier, liveTrades: 0 });
      size = Math.min(size, (V * params.maxMarginPct) / 100, (V * params.riskPerTradePct) / 100 / Math.max(1e-9, stopPct));
      // RiskGate VaR: 1.65 * dailyVol * (open + new) must fit inside the cushion
      const varPerUnit = (1.65 * (params.dailyVolBps ?? 500)) / 10_000;
      size = Math.min(size, Math.max(0, C / varPerUnit - openNotional), cash);
      if (size < 1e-4) continue;
      pending[a] = { kind: s.orderType, price: s.entry, stop: s.stop, target: s.target, notional: size };
    }
    const v = markValue(i);
    equity.push(v);
    minEquity = Math.min(minEquity, v);
    if (open.length) exposedBars++;
  }
  const lastI = to - 1;
  for (const p of [...open]) close(p, series[p.asset].bars[lastI].c, series[p.asset].bars[lastI].t, "open", paramsAt(lastI).roundTripCostPct);
  return { trades, equity, stats: stats(series, trades, equity, from, to, exposedBars, minEquity, paramsAt(from).piBps) };
}

function stats(series: FeatureSeries[], trades: SimTrade[], equity: number[], from: number, to: number, exposedBars: number, minEquity: number, piBps: number): BacktestStats {
  const bars = series[0].bars;
  const years = Math.max(1e-9, (bars[to - 1].t - bars[from].t) / (365 * 86400));
  const end = equity.length ? equity[equity.length - 1] : 1;
  let peak = 1;
  let mdd = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, (peak - v) / peak);
  }
  // daily returns from 4h equity (6 bars per day)
  const daily: number[] = [];
  for (let k = 6; k < equity.length; k += 6) daily.push(equity[k] / equity[k - 6] - 1);
  const mean = daily.reduce((a, b) => a + b, 0) / Math.max(1, daily.length);
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, daily.length - 1));
  const gains = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const losses = -trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const bh = series.reduce((a, s) => a + (s.bars[to - 1].c / s.bars[from].o - 1) / series.length, 0);
  const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    from: new Date(bars[from].t * 1000).toISOString().slice(0, 10),
    to: new Date(bars[to - 1].t * 1000).toISOString().slice(0, 10),
    years: round(years),
    trades: trades.length,
    winRate: round(trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0, 3),
    avgR: round(trades.length ? trades.reduce((a, t) => a + t.r, 0) / trades.length : 0, 3),
    profitFactor: losses > 0 ? round(gains / losses) : null,
    totalReturnPct: round((end - 1) * 100),
    cagrPct: round((Math.pow(Math.max(end, 1e-9), 1 / years) - 1) * 100),
    maxDrawdownPct: round(mdd * 100),
    sharpe: daily.length > 30 && sd > 0 ? round((mean / sd) * Math.sqrt(365)) : null,
    exposurePct: round((exposedBars / Math.max(1, equity.length)) * 100, 1),
    floorHeld: minEquity >= piBps / 10_000,
    buyHoldPct: round(bh * 100),
  };
}

/** Align several 4h series on common timestamps (oldest first). */
export function alignBars(...series: Bar[][]): Bar[][] {
  const common = series.map((s) => new Set(s.map((b) => b.t))).reduce((a, b) => new Set([...a].filter((t) => b.has(t))));
  return series.map((s) => s.filter((b) => common.has(b.t)));
}

