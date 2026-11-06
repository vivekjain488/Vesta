import { keccak256, toBytes } from "viem";

export const VENUE = "binance-usdm";
export const SOURCE = "https://fapi.binance.com";
export interface MarketSnapshot {
  version: 1; venue: typeof VENUE; marketType: "perpetual"; symbol: string;
  observedAtMs: number; sourceAtMs: number;
  markPrice: string; indexPrice: string; fundingRate: string; nextFundingAtMs: number;
  openInterest: string; openInterestAtMs: number;
  book: { updateId: string; atMs: number; bids: [string, string][]; asks: [string, string][] };
  provenance: { source: string; endpoints: string[] };
}
export interface CandleWindow {
  version: 1; venue: typeof VENUE; symbol: string; interval: "4h"; observedAtMs: number;
  bars: { t: number; o: number; h: number; l: number; c: number; v: number }[];
  lastClosedAtMs: number; source: string;
}
export const contentHash = (value: unknown) => keccak256(toBytes(JSON.stringify(value)));
export function marketSymbol(value: string) { if (!/^[A-Z0-9]{2,16}USDT$/.test(value)) throw new Error("Expected an uppercase USDT futures symbol, e.g. BTCUSDT"); return value; }
const decimal = (value: unknown, positive = false) => typeof value === "string" && /^-?\d{1,30}(\.\d{1,18})?$/.test(value) && Number.isFinite(Number(value)) && (!positive || Number(value) > 0);
const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
export function validateSnapshot(s: MarketSnapshot, now = Date.now(), maxSourceAgeMs = 30000) {
  marketSymbol(s.symbol);
  if (s.version !== 1 || s.venue !== VENUE || s.marketType !== "perpetual" || s.provenance?.source !== SOURCE) throw new Error("Invalid market provenance");
  if (!time(s.observedAtMs) || !time(s.sourceAtMs) || !time(s.book?.atMs) || !time(s.openInterestAtMs) || !time(s.nextFundingAtMs)) throw new Error("Invalid source timestamps");
  for (const timestamp of [s.sourceAtMs, s.book.atMs, s.openInterestAtMs, s.observedAtMs]) if (timestamp > now + 5000 || now - timestamp > maxSourceAgeMs) throw new Error("Market observation is stale or has a future timestamp");
  if (![s.markPrice, s.indexPrice].every((v) => decimal(v, true)) || !decimal(s.openInterest) || Number(s.openInterest) < 0 || !decimal(s.fundingRate) || Math.abs(Number(s.fundingRate)) > 1) throw new Error("Invalid market prices, funding or open interest");
  if (!/^\d+$/.test(s.book.updateId)) throw new Error("Invalid order-book update ID");
  for (const [side, descending] of [[s.book.bids, true], [s.book.asks, false]] as const) {
    if (!Array.isArray(side) || side.length < 1 || side.length > 20) throw new Error("Invalid order-book depth");
    for (let i = 0; i < side.length; i++) {
      if (!Array.isArray(side[i]) || side[i].length !== 2 || !side[i].every((v) => decimal(v, true))) throw new Error("Invalid order-book level");
      if (i && (descending ? Number(side[i - 1][0]) <= Number(side[i][0]) : Number(side[i - 1][0]) >= Number(side[i][0]))) throw new Error("Unsorted order book");
    }
  }
  if (Number(s.book.bids[0][0]) >= Number(s.book.asks[0][0])) throw new Error("Crossed or locked order book");
  return s;
}
export function validateCandles(window: CandleWindow, now = Date.now()) {
  marketSymbol(window.symbol);
  if (window.version !== 1 || window.venue !== VENUE || window.interval !== "4h" || window.source !== SOURCE || !time(window.observedAtMs) || window.observedAtMs > now + 5000 || !Array.isArray(window.bars) || window.bars.length < 1 || window.bars.length > 400) throw new Error("Invalid candle window");
  for (let i = 0; i < window.bars.length; i++) {
    const b = window.bars[i];
    if (!time(b.t) || b.t % 14400 || [b.o, b.h, b.l, b.c, b.v].some((v) => !Number.isFinite(v)) || Math.min(b.o, b.h, b.l, b.c) <= 0 || b.v < 0 || b.h < Math.max(b.o, b.c, b.l) || b.l > Math.min(b.o, b.c) || (b.t + 14400) * 1000 > now || i > 0 && b.t - window.bars[i - 1].t !== 14400) throw new Error("Invalid, unclosed or discontinuous candles");
  }
  if (window.lastClosedAtMs !== (window.bars.at(-1)!.t + 14400) * 1000 - 1) throw new Error("Candle close timestamp mismatch");
  return window;
}
async function publicJson(path: string, signal?: AbortSignal) {
  const response = await fetch(`${SOURCE}${path}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Binance public feed returned HTTP ${response.status}`);
  const data: any = await response.json(); if (data?.code && data.code < 0) throw new Error(`Binance public feed error ${data.code}`); return data;
}
export async function collectSnapshot(symbol: string, signal?: AbortSignal): Promise<MarketSnapshot> {
  marketSymbol(symbol);
  const paths = [`/fapi/v1/premiumIndex?symbol=${symbol}`, `/fapi/v1/depth?symbol=${symbol}&limit=20`, `/fapi/v1/openInterest?symbol=${symbol}`];
  const [premium, book, interest] = await Promise.all(paths.map((p) => publicJson(p, signal)));
  if (premium.symbol !== symbol || interest.symbol !== symbol) throw new Error("Exchange symbol mismatch");
  return validateSnapshot({ version: 1, venue: VENUE, marketType: "perpetual", symbol, observedAtMs: Date.now(), sourceAtMs: Number(premium.time), markPrice: premium.markPrice, indexPrice: premium.indexPrice, fundingRate: premium.lastFundingRate, nextFundingAtMs: premium.nextFundingTime, openInterest: interest.openInterest, openInterestAtMs: interest.time, book: { updateId: String(book.lastUpdateId), atMs: book.T ?? book.E, bids: book.bids, asks: book.asks }, provenance: { source: SOURCE, endpoints: paths } });
}
export async function collectCandles(symbol: string, signal?: AbortSignal): Promise<CandleWindow> {
  marketSymbol(symbol); const rows = await publicJson(`/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=401`, signal); const now = Date.now();
  if (!Array.isArray(rows)) throw new Error("Invalid candle response");
  const closed = rows.filter((r: any[]) => Number(r[6]) < now).slice(-400);
  return validateCandles({ version: 1, venue: VENUE, symbol, interval: "4h", observedAtMs: now, lastClosedAtMs: Number(closed.at(-1)?.[6]), source: SOURCE, bars: closed.map((r: any[]) => ({ t: Number(r[0]) / 1000, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) })) }, now);
}
