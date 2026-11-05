import { atr, ema, last, rsi, type Bar } from "./indicators";
import { validateStrategyConfig, type StrategyConfig } from "./agent-config";

export interface FuturesCandidate {
  symbol: string;
  side: "long" | "short";
  observedAt: number;
  candleAt: number;
  referencePrice: number;
  stopPrice: number;
  targetPrice: number;
  atr: number;
}
export interface ExecutionSnapshot {
  symbol: string;
  fetchedAt: number;
  sourceTimestamp: number;
  bid: number;
  ask: number;
  mark: number;
  availableNotionalUsd: number;
  roundTripCostBps: number; // entry+exit fees, expected funding/borrow, spread and stressed impact
  liquidationPrice: number; // supplied by a venue-specific margin calculator, never guessed here
  marketOpen: boolean;
  protectionAvailable: boolean;
}
export interface PaperAccount {
  equityUsd: number;
  freeMarginUsd: number;
  grossNotionalUsd: number;
  marginUsedUsd: number;
  dailyStartEquityUsd: number;
  dailyPnlUsd: number;
  updatedAt: number;
}

/** Candidate generation only. This is a research hypothesis, not a forecast of the next 30 seconds. */
export function futuresCandidate(config: StrategyConfig, symbol: string, bars: Bar[], now: number): FuturesCandidate | null {
  const c = validateStrategyConfig(config);
  if (c.market !== "perpetual" || !c.symbols.includes(symbol)) return null;
  const closed = bars.filter((b) => b.t + 14400 <= now);
  if (closed.length < 220) return null;
  if (closed.some((b, i) => ![b.t, b.o, b.h, b.l, b.c, b.v].every(Number.isFinite) || b.l <= 0 || b.h < Math.max(b.o, b.c, b.l) || b.l > Math.min(b.o, b.c) || b.v < 0 || (i > 0 && b.t - closed[i - 1].t !== 14400))) return null;
  const bar = last(closed);
  if (now - (bar.t + 14400) >= 14400) return null;
  const closes = closed.map((b) => b.c);
  const e50 = last(ema(closes, 50));
  const e200 = last(ema(closes, 200));
  const a = last(atr(closed, 14));
  if (!Number.isFinite(a) || a <= 0) return null;
  let side: "long" | "short" | null = null;
  if (c.template === "perp-trend") {
    const previous = closed.slice(-c.parameters.breakoutBars - 1, -1);
    if (bar.c > Math.max(...previous.map((b) => b.h)) && bar.c > e200 && e50 > e200) side = "long";
    if (bar.c < Math.min(...previous.map((b) => b.l)) && bar.c < e200 && e50 < e200) side = "short";
  } else if (c.template === "perp-range") {
    const range = Math.abs(e50 - e200) < a;
    const strength = last(rsi(closes, 14));
    if (range && strength < c.parameters.rsiOversold && bar.c < e50 - a) side = "long";
    if (range && strength > 100 - c.parameters.rsiOversold && bar.c > e50 + a) side = "short";
  }
  if (!side || (c.direction !== "both" && c.direction !== side)) return null;
  const sign = side === "long" ? 1 : -1;
  const stopPrice = bar.c - sign * c.parameters.stopAtr * a;
  const targetPrice = bar.c + sign * c.parameters.targetAtr * a;
  if (Math.min(stopPrice, targetPrice) <= 0) return null;
  return { symbol, side, observedAt: now, candleAt: bar.t, referencePrice: bar.c, stopPrice, targetPrice, atr: a };
}

export type Preflight = { ok: false; reason: string } | { ok: true; notionalUsd: number; marginUsd: number; entryPrice: number; modeledLossUsd: number };

/** Must run AFTER reasoning with a newly fetched quote/account. Never authorizes a live order. */
export function preflightFutures(config: StrategyConfig, signal: FuturesCandidate, q: ExecutionSnapshot, account: PaperAccount, now: number): Preflight {
  const c = validateStrategyConfig(config);
  const fail = (reason: string): Preflight => ({ ok: false, reason });
  if (c.market !== "perpetual" || !c.symbols.includes(signal.symbol) || q.symbol !== signal.symbol) return fail("MARKET_MISMATCH");
  if (!["long", "short"].includes(signal.side) || (c.direction !== "both" && c.direction !== signal.side)) return fail("SIDE_NOT_ALLOWED");
  const values = [signal.observedAt, signal.candleAt, signal.referencePrice, signal.stopPrice, signal.targetPrice, signal.atr,
    q.fetchedAt, q.sourceTimestamp, q.bid, q.ask, q.mark, q.availableNotionalUsd, q.roundTripCostBps, q.liquidationPrice,
    account.equityUsd, account.freeMarginUsd, account.grossNotionalUsd, account.marginUsedUsd, account.dailyStartEquityUsd, account.dailyPnlUsd, account.updatedAt];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v)) || !Number.isFinite(now)) return fail("INVALID_DATA");
  if (signal.observedAt > now || now - signal.observedAt > c.execution.maxDecisionAgeSeconds || signal.candleAt + 14400 > signal.observedAt || signal.observedAt - signal.candleAt >= 28800) return fail("DECISION_STALE");
  if (q.sourceTimestamp > now || q.fetchedAt > now || q.sourceTimestamp > q.fetchedAt || q.fetchedAt < signal.observedAt || now - q.sourceTimestamp > c.execution.maxQuoteAgeSeconds || now - q.fetchedAt > c.execution.maxQuoteAgeSeconds) return fail("QUOTE_STALE");
  if (account.updatedAt > now || account.updatedAt < signal.observedAt || now - account.updatedAt > c.execution.maxQuoteAgeSeconds) return fail("ACCOUNT_STALE");
  if (q.marketOpen !== true || q.protectionAvailable !== true) return fail("PROTECTION_UNAVAILABLE");
  if (q.bid <= 0 || q.ask < q.bid || q.mark <= 0 || q.liquidationPrice <= 0 || q.availableNotionalUsd <= 0 || q.roundTripCostBps < 0 || signal.referencePrice <= 0 || signal.atr <= 0 || account.equityUsd <= 0 || account.dailyStartEquityUsd <= 0 || account.freeMarginUsd < 0 || account.grossNotionalUsd < 0 || account.marginUsedUsd < 0) return fail("INVALID_DATA");
  if (account.dailyPnlUsd <= -account.dailyStartEquityUsd * c.risk.maxDailyLossPct / 100) return fail("DAILY_LOSS_LIMIT");
  const entry = signal.side === "long" ? q.ask : q.bid;
  const mid = (q.ask + q.bid) / 2;
  if ((q.ask - q.bid) / mid * 10000 > c.execution.maxSpreadBps) return fail("SPREAD_TOO_WIDE");
  if (Math.abs(q.mark / mid - 1) * 10000 > c.execution.maxPriceDriftBps) return fail("MARK_DIVERGENCE");
  const driftLimit = Math.min(signal.referencePrice * c.execution.maxPriceDriftBps / 10000, signal.atr * 0.25);
  if (Math.abs(entry - signal.referencePrice) > driftLimit) return fail("PRICE_DRIFT");
  const sign = signal.side === "long" ? 1 : -1;
  const stopDistance = sign * (entry - signal.stopPrice);
  const reward = sign * (signal.targetPrice - entry);
  if (stopDistance <= 0 || reward <= 0) return fail("STOP_OR_TARGET_CROSSED");
  if (q.roundTripCostBps > c.execution.maxRoundTripCostBps) return fail("COST_TOO_HIGH");
  const costFraction = (q.roundTripCostBps + c.execution.maxSlippageBps) / 10000;
  if ((reward / entry - costFraction) / (stopDistance / entry + costFraction) < c.parameters.minRewardRisk) return fail("NET_REWARD_RISK");
  // The stop must precede liquidation by a full ATR, including configured stressed slippage.
  if (sign * (signal.stopPrice - q.liquidationPrice) < signal.atr + entry * c.execution.maxSlippageBps / 10000) return fail("LIQUIDATION_BUFFER");
  const dailyRoom = account.dailyStartEquityUsd * c.risk.maxDailyLossPct / 100 + Math.min(0, account.dailyPnlUsd);
  const lossBudget = Math.min(account.equityUsd * c.risk.riskPerTradePct / 100, dailyRoom);
  const lossFraction = stopDistance / entry + costFraction;
  const marginRoom = Math.min(account.freeMarginUsd, Math.max(0, account.equityUsd * c.risk.maxMarginPct / 100 - account.marginUsedUsd));
  const notionalUsd = Math.min(lossBudget / lossFraction, Math.max(0, c.risk.maxNotionalUsd - account.grossNotionalUsd), marginRoom * c.risk.maxLeverage, q.availableNotionalUsd);
  if (notionalUsd < 1) return fail("NO_RISK_BUDGET");
  return { ok: true, notionalUsd, marginUsd: notionalUsd / c.risk.maxLeverage, entryPrice: entry, modeledLossUsd: notionalUsd * lossFraction };
}
