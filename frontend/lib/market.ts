"use client";
/**
 * Public 4h candles for the dashboard chart (read-only, browser-side). Binance klines first,
 * Kraken OHLC as fallback. The latest candle is still forming and updates with the market.
 */
import type { Bar } from "@perpetua/core";

const PAIRS: Record<string, { binance: string; kraken: string }> = {
  LINK: { binance: "LINKUSDT", kraken: "LINKUSD" },
  ETH: { binance: "ETHUSDT", kraken: "ETHUSD" },
  WETH: { binance: "ETHUSDT", kraken: "ETHUSD" },
  BTC: { binance: "BTCUSDT", kraken: "XBTUSD" },
  CBBTC: { binance: "BTCUSDT", kraken: "XBTUSD" },
  WBTC: { binance: "BTCUSDT", kraken: "XBTUSD" },
  SOL: { binance: "SOLUSDT", kraken: "SOLUSD" },
};

export interface MarketSeries {
  symbol: string;
  bars: Bar[];
  source: "Binance" | "Kraken";
  fetchedAt: number;
}

export function binanceStreamUrl(symbol: string) {
  const pair = PAIRS[symbol.toUpperCase()];
  return pair ? `wss://stream.binance.com:9443/ws/${pair.binance.toLowerCase()}@kline_4h` : null;
}

/** One combined Binance stream: every trade (live line), the forming 1m candle, and the rolling 24h ticker. */
export function binanceLiveUrl(symbol: string) {
  const pair = PAIRS[symbol.toUpperCase()];
  if (!pair) return null;
  const p = pair.binance.toLowerCase();
  return `wss://stream.binance.com:9443/stream?streams=${p}@aggTrade/${p}@kline_1m/${p}@miniTicker`;
}

export interface MinuteCandle { time: number; open: number; high: number; low: number; close: number }
export interface MinuteSeries { candles: MinuteCandle[]; source: "Binance" | "Kraken" }

/** Recent closed + forming 1m candles (times in unix seconds) to seed the live chart. */
export async function fetchMinuteCandles(symbol: string, limit = 120, signal?: AbortSignal): Promise<MinuteSeries> {
  const pair = PAIRS[symbol.toUpperCase()];
  if (!pair) throw new Error(`No public market feed for ${symbol}`);
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair.binance}&interval=1m&limit=${limit}`, { signal, cache: "no-store" });
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const j: any[] = await r.json();
    const candles = j.map((x) => ({ time: Math.floor(x[0] / 1000), open: +x[1], high: +x[2], low: +x[3], close: +x[4] }));
    if (candles.length) return { candles, source: "Binance" };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
  }
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair.kraken}&interval=1`, { signal, cache: "no-store" });
  const j: any = await r.json();
  const key = Object.keys(j.result ?? {}).find((k) => k !== "last");
  if (!key) throw new Error("Market data unavailable");
  const candles = (j.result[key] as any[]).map((x) => ({ time: Number(x[0]), open: +x[1], high: +x[2], low: +x[3], close: +x[4] })).slice(-limit);
  if (!candles.length) throw new Error("Market data unavailable");
  return { candles, source: "Kraken" };
}

/** Kraken last trade price, polled when the Binance stream is unreachable. */
export async function fetchKrakenPrice(symbol: string, signal?: AbortSignal): Promise<number> {
  const pair = PAIRS[symbol.toUpperCase()];
  if (!pair) throw new Error(`No public market feed for ${symbol}`);
  const j: any = await (await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair.kraken}`, { signal, cache: "no-store" })).json();
  const key = Object.keys(j.result ?? {})[0];
  const price = key ? Number(j.result[key].c?.[0]) : NaN;
  if (!Number.isFinite(price)) throw new Error("Market data unavailable");
  return price;
}

export function supportedSymbol(symbol: string) {
  return PAIRS[symbol.toUpperCase()] !== undefined;
}

export type KlineInterval = "15m" | "1h" | "4h" | "1d";
const KRAKEN_MINUTES: Record<KlineInterval, number> = { "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };

/** Historical candles at any supported interval (Binance up to 1000 bars, Kraken fallback up to 720). */
export async function fetchKlines(symbol: string, interval: KlineInterval, limit: number, signal?: AbortSignal): Promise<MarketSeries> {
  const pair = PAIRS[symbol.toUpperCase()];
  if (!pair) throw new Error(`No public market feed for ${symbol}`);
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair.binance}&interval=${interval}&limit=${Math.min(limit, 1000)}`, { signal, cache: "no-store" });
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const j: any[] = await r.json();
    const bars = j.map((x) => ({ t: Math.floor(x[0] / 1000), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
    if (bars.length) return { symbol, bars, source: "Binance", fetchedAt: Date.now() };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
  }
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair.kraken}&interval=${KRAKEN_MINUTES[interval]}`, { signal, cache: "no-store" });
  const j: any = await r.json();
  const key = Object.keys(j.result ?? {}).find((k) => k !== "last");
  if (!key) throw new Error("Market data unavailable");
  const bars = (j.result[key] as any[]).map((x) => ({ t: Number(x[0]), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6] })).slice(-limit);
  if (!bars.length) throw new Error("Market data unavailable");
  return { symbol, bars, source: "Kraken", fetchedAt: Date.now() };
}

export async function fetchCandles4h(symbol: string, limit = 90, signal?: AbortSignal): Promise<MarketSeries> {
  const pair = PAIRS[symbol.toUpperCase()];
  if (!pair) throw new Error(`No public market feed for ${symbol}`);
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair.binance}&interval=4h&limit=${limit + 1}`, { signal, cache: "no-store" });
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const j: any[] = await r.json();
    const bars = j.map((x) => ({ t: Math.floor(x[0] / 1000), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).slice(-limit);
    if (bars.length) return { symbol, bars, source: "Binance", fetchedAt: Date.now() };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
  }
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair.kraken}&interval=240`, { signal, cache: "no-store" });
  const j: any = await r.json();
  const key = Object.keys(j.result ?? {}).find((k) => k !== "last");
  if (!key) throw new Error("Market data unavailable");
  const bars = (j.result[key] as any[]).map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6] })).slice(-limit);
  if (!bars.length) throw new Error("Market data unavailable");
  return { symbol, bars, source: "Kraken", fetchedAt: Date.now() };
}
