import { gunzipSync, gzipSync } from "node:zlib";
import { and, desc, eq, lt } from "@arkiv-network/sdk/query";
import { getAddress, type Address } from "viem";
import { arkivPublic } from "./client";
import { MarketObservation, MarketCandleWindow, dec, jsonBytes, u64 } from "./schemas";
import { contentHash, marketSymbol, validateSnapshot, validateCandles, type MarketSnapshot, type CandleWindow } from "./market-data";

export type MarketWrite = { uid: string; kind: "latest" | "snapshot"; bucketAtMs: number; data: MarketSnapshot } | { uid: string; kind: "candles"; data: CandleWindow };
export const schemaFor = (item: MarketWrite) => item.kind === "candles" ? MarketCandleWindow : MarketObservation;
export const writeHash = (item: MarketWrite) => contentHash(item);
export function writeValues(item: MarketWrite, now = Date.now()) {
  const s = item.data;
  if (item.kind === "candles") return { uid: item.uid, venue: s.venue, symbol: s.symbol, interval: "4h", observed_at_ms: u64(BigInt(s.observedAtMs)), last_closed_at_ms: u64(BigInt(item.data.lastClosedAtMs)), content_hash: contentHash(s), payload: new Uint8Array(gzipSync(jsonBytes(s))) };
  const quote = item.data;
  return { uid: item.uid, record_type: item.kind, venue: quote.venue, market_type: quote.marketType, symbol: quote.symbol, bucket_at_ms: u64(BigInt(item.bucketAtMs)), source_at_ms: u64(BigInt(quote.sourceAtMs)), observed_at_ms: u64(BigInt(quote.observedAtMs)), published_at_ms: u64(BigInt(now)), bid: dec(quote.book.bids[0][0]), ask: dec(quote.book.asks[0][0]), mark_price: dec(quote.markPrice), index_price: dec(quote.indexPrice), funding_rate: dec(quote.fundingRate), open_interest: dec(quote.openInterest), content_hash: contentHash(quote), payload: jsonBytes(quote) };
}
export const column = (value: any) => value?.value ?? value;
export function decodeMarketRow(row: any, compressed = false) {
  const bytes = column(row.payload); const data = typeof bytes === "string" && bytes.startsWith("0x") ? Buffer.from(bytes.slice(2), "hex") : Buffer.from(bytes);
  const object = JSON.parse((compressed ? gunzipSync(data, { maxOutputLength: 256 * 1024 }) : data).toString("utf8"));
  if (contentHash(object) !== column(row.content_hash) || object.symbol !== column(row.symbol) || object.venue !== column(row.venue)) throw new Error("Arkiv market payload/hash mismatch");
  return object;
}
export function marketWriterAddress(): Address {
  const address = process.env.ARKIV_MARKET_WRITER_ADDRESS;
  if (!address) throw new Error("ARKIV_MARKET_WRITER_ADDRESS is not configured"); return getAddress(address);
}
export async function findMarketEntity(item: MarketWrite, owner: Address) {
  const result = await (arkivPublic() as any).select({ $key: true }).from(schemaFor(item)).where(eq("uid", item.uid)).ownedBy(owner).limit(2).fetch();
  if (result.entities.length > 1) throw new Error(`Duplicate market UID ${item.uid}; refusing to choose an arbitrary record`);
  return result.entities[0]?.$key;
}
export async function latestMarket(symbol: string, opts: { maxAgeMs?: number; owner?: Address } = {}) {
  marketSymbol(symbol); const owner = opts.owner ?? marketWriterAddress();
  const result = await (arkivPublic() as any).select().from(MarketObservation).where(and(eq("symbol", symbol), eq("venue", "binance-usdm"), eq("record_type", "latest"))).ownedBy(owner).limit(2).fetch();
  if (result.entities.length !== 1) throw new Error("No unique published market state found");
  const row = result.entities[0]; const data = decodeMarketRow(row) as MarketSnapshot;
  validateSnapshot(data, Date.now(), opts.maxAgeMs ?? 45000);
  return { entityKey: row.$key, writer: owner, publishedAtMs: Number(column(row.published_at_ms)), ageMs: Date.now() - Math.min(data.sourceAtMs, data.book.atMs, data.openInterestAtMs, data.observedAtMs), data };
}
export async function marketCandles(symbol: string, limit = 400, owner = marketWriterAddress()) {
  marketSymbol(symbol); if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error("Candle limit must be 1–400");
  const result = await (arkivPublic() as any).select().from(MarketCandleWindow).where(and(eq("symbol", symbol), eq("venue", "binance-usdm"), eq("interval", "4h"))).ownedBy(owner).limit(2).fetch();
  if (result.entities.length !== 1) throw new Error("No unique published candle window found");
  const row = result.entities[0]; const data = validateCandles(decodeMarketRow(row, true));
  if (data.lastClosedAtMs !== Math.floor(Date.now() / 14400000) * 14400000 - 1) throw new Error("Arkiv candle mirror is missing the latest closed candle");
  return { entityKey: row.$key, writer: owner, ...data, bars: data.bars.slice(-limit) };
}
export async function marketHistory(symbol: string, beforeMs = Date.now() + 1, limit = 50, owner = marketWriterAddress()) {
  marketSymbol(symbol); if (!Number.isSafeInteger(beforeMs) || beforeMs < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid history cursor or limit");
  const result = await (arkivPublic() as any).select().from(MarketObservation).where(and(eq("symbol", symbol), eq("venue", "binance-usdm"), eq("record_type", "snapshot"), lt("bucket_at_ms", u64(BigInt(beforeMs))))).ownedBy(owner).orderBy(desc("bucket_at_ms")).limit(limit).fetch();
  const rows = result.entities.map((row: any) => ({ entityKey: row.$key, bucketAtMs: Number(column(row.bucket_at_ms)), publishedAtMs: Number(column(row.published_at_ms)), data: decodeMarketRow(row) as MarketSnapshot }));
  return { writer: owner, rows, nextBeforeMs: rows.length === limit ? rows.at(-1).bucketAtMs : null };
}
