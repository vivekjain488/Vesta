/** Technical indicators over OHLCV bars. Pure functions, no LLM, fully testable. */

export interface Bar {
  t: number; // open time, unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (Number.isNaN(ef[i]) || Number.isNaN(es[i]) ? NaN : ef[i] - es[i]));
  const firstValid = line.findIndex((x) => !Number.isNaN(x));
  const sig: number[] = new Array(closes.length).fill(NaN);
  if (firstValid >= 0) {
    const sub = ema(line.slice(firstValid), signal);
    sub.forEach((v, j) => (sig[firstValid + j] = v));
  }
  const hist = line.map((v, i) => (Number.isNaN(v) || Number.isNaN(sig[i]) ? NaN : v - sig[i]));
  return { line, signal: sig, hist };
}

/** Wilder's ATR. */
export function atr(bars: Bar[], period = 14): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  if (bars.length <= period) return out;
  const tr = bars.map((b, i) =>
    i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)),
  );
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i];
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Donchian channel of the PREVIOUS `period` bars (so a breakout is close > prior high). */
export function donchian(bars: Bar[], period = 20) {
  const upper: number[] = new Array(bars.length).fill(NaN);
  const lower: number[] = new Array(bars.length).fill(NaN);
  for (let i = period; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      hi = Math.max(hi, bars[j].h);
      lo = Math.min(lo, bars[j].l);
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** Log returns. */
export function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

/** Rolling realised volatility (daily units) from 4h bars: 6 bars per day. */
export function rollingDailyVol(closes: number[], windowBars = 180, barsPerDay = 6): number[] {
  const r = logReturns(closes);
  const out: number[] = new Array(closes.length).fill(NaN);
  for (let i = windowBars; i < closes.length; i++) {
    out[i] = stdev(r.slice(i - windowBars, i)) * Math.sqrt(barsPerDay);
  }
  return out;
}

export function percentileRank(xs: number[], value: number): number {
  const v = xs.filter((x) => !Number.isNaN(x));
  if (v.length === 0) return 0;
  return v.filter((x) => x <= value).length / v.length;
}

export const last = <T>(xs: T[]): T => xs[xs.length - 1];
