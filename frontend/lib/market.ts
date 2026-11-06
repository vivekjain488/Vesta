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

export function supportedSymbol(symbol: string) {
  return PAIRS[symbol.toUpperCase()] !== undefined;
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
