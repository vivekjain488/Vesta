import "dotenv/config";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Hex } from "viem";
import { collectCandles, collectSnapshot, marketSymbol } from "./market-data";
import { MarketPublisher, atomicJson, safeMarketError } from "./market-publisher";
import type { MarketWrite } from "./market-store";

const directory = resolve(process.env.PERPETUA_STATE_DIR ?? ".perpetua"); mkdirSync(directory, { recursive: true });
const symbols = [...new Set((process.env.ARKIV_MARKET_SYMBOLS ?? "BTCUSDT,ETHUSDT,LINKUSDT").split(",").map((v) => marketSymbol(v.trim())))];
if (!symbols.length || symbols.length > 30) throw new Error("Choose 1–30 market symbols");
const number = (name: string, fallback: number, min: number, max: number) => { const value = Number(process.env[name] ?? fallback); if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}–${max}`); return value; };
const pollMs = number("ARKIV_MARKET_POLL_SECONDS", 5, 3, 300) * 1000;
const publishMs = number("ARKIV_MARKET_PUBLISH_SECONDS", 15, 10, 300) * 1000;
const candlePollMs = number("ARKIV_MARKET_CANDLE_SECONDS", 60, 30, 3600) * 1000;
const privateKey = process.env.ARKIV_MARKET_PRIVATE_KEY as Hex | undefined;
if (!privateKey) throw new Error("ARKIV_MARKET_PRIVATE_KEY is required; this service never silently writes to a local-only outbox");
const lock = resolve(directory, "market-service.pid");
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8")); let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (e: any) { if (e.code !== "ESRCH") throw e; }
  if (alive) {
    const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (/(?:^|[\/ ])market-service\.ts(?:\s|$)/.test(command.stdout)) throw new Error(`Market service already owns this directory (PID ${pid})`);
    if (command.status !== 0 && command.status !== 1) throw new Error("Cannot verify the existing market-service lock owner");
  }
  unlinkSync(lock);
}
const descriptor = openSync(lock, "wx"); writeFileSync(descriptor, String(process.pid)); closeSync(descriptor);
const publisher = new MarketPublisher({ privateKey, file: resolve(directory, "market-writer.json"), maxPending: number("ARKIV_MARKET_MAX_PENDING", 600, 30, 5000), retentionDays: number("ARKIV_MARKET_RETENTION_DAYS", 7, 1, 30), minimumBalanceWei: 10000000000000000n });
if (process.env.ARKIV_MARKET_WRITER_ADDRESS?.toLowerCase() !== publisher.owner.toLowerCase()) throw new Error("Market writer key/address mismatch");
const status: any = { pid: process.pid, startedAtMs: Date.now(), writer: publisher.owner, venue: "binance-usdm", symbols, pollMs, publishMs, candlePollMs, coverage: "sampled top-20 book, mark/index, funding, open interest, closed 4h candles", sources: {}, publication: {} };
const abort = new AbortController(); let stopping = false, collecting = false, publishing = false;
let nextPublish = 0, nextCandles = 0, nextWrite = 0, failures = 0;
const sourceFailures = new Map<string, { count: number; retryAt: number }>();
function saveStatus() {
  status.updatedAtMs = Date.now(); status.publication = { lastPublishedAtMs: publisher.lastPublishedAtMs, pending: publisher.pending, droppedHistorySamples: publisher.dropped, balanceWei: publisher.balanceWei, error: publisher.lastError, recentTransactions: publisher.recentTransactions };
  atomicJson(resolve(directory, "market-service-status.json"), status);
}
async function collect() {
  if (collecting || stopping) return; collecting = true;
  const publish = Date.now() >= nextPublish; const candles = Date.now() >= nextCandles;
  if (publish) nextPublish = Date.now() + publishMs;
  if (candles) nextCandles = Date.now() + candlePollMs;
  try {
    await Promise.all(symbols.map(async (symbol) => {
      if ((sourceFailures.get(symbol)?.retryAt ?? 0) > Date.now()) return;
      try {
        const data = await collectSnapshot(symbol, abort.signal);
        status.sources[symbol] = { ...status.sources[symbol], lastObservedAtMs: data.observedAtMs, sourceAtMs: data.sourceAtMs, error: null }; sourceFailures.delete(symbol);
        // The fast local cache is diagnostic only; public consumers query confirmed Arkiv entities.
        atomicJson(resolve(directory, `market-cache-${symbol}.json`), data);
        if (publish) {
          const bucketAtMs = Math.floor(data.observedAtMs / publishMs) * publishMs;
          const items: MarketWrite[] = [{ uid: `binance-usdm:${symbol}:latest`, kind: "latest", bucketAtMs, data }, { uid: `binance-usdm:${symbol}:${bucketAtMs}`, kind: "snapshot", bucketAtMs, data }]; publisher.enqueue(items);
        }
      } catch (error) {
        const count = (sourceFailures.get(symbol)?.count ?? 0) + 1; const retryAt = Date.now() + Math.min(60000, pollMs * 2 ** Math.min(count - 1, 4)); sourceFailures.set(symbol, { count, retryAt });
        status.sources[symbol] = { ...status.sources[symbol], error: safeMarketError(error), failedAtMs: Date.now(), retryAtMs: retryAt };
      }
    }));
    if (candles) await Promise.all(symbols.map(async (symbol) => {
      try {
        const data = await collectCandles(symbol, abort.signal); publisher.enqueue([{ uid: `binance-usdm:${symbol}:4h`, kind: "candles", data }]);
        status.sources[symbol] = { ...status.sources[symbol], lastCandleFetchAtMs: data.observedAtMs, lastClosedCandleAtMs: data.lastClosedAtMs, candleError: null };
      } catch (error) { status.sources[symbol] = { ...status.sources[symbol], candleError: safeMarketError(error) }; }
    }));
    saveStatus();
  } finally { collecting = false; }
}
async function publish() {
  if (publishing || stopping || Date.now() < nextWrite) return; publishing = true;
  try { await publisher.flush(); failures = 0; nextWrite = Date.now() + 500; }
  catch (error) { nextWrite = Date.now() + Math.min(120000, 3000 * 2 ** Math.min(failures++, 5)); console.error(`[market] ${safeMarketError(error)}`); }
  finally { publishing = false; saveStatus(); }
}
let collectionTimer: NodeJS.Timeout | undefined, publicationTimer: NodeJS.Timeout | undefined;
async function shutdown() {
  if (stopping) return; stopping = true; abort.abort(); clearInterval(collectionTimer); clearInterval(publicationTimer);
  while (collecting || publishing) await new Promise((done) => setTimeout(done, 50));
  status.stoppedAtMs = Date.now(); saveStatus(); if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
}
process.once("SIGINT", () => void shutdown()); process.once("SIGTERM", () => void shutdown());
try {
  console.log(`[market] live Arkiv mirror ${publisher.owner}; ${symbols.join(", ")}; collecting every ${pollMs / 1000}s, publishing every ${publishMs / 1000}s`);
  await collect();
  if (process.argv.includes("--once")) {
    while (publisher.pending) await publisher.flush();
    saveStatus();
    if (symbols.some((s) => status.sources[s]?.error || status.sources[s]?.candleError)) throw new Error("Some market sources failed; see market-service-status.json");
    await shutdown();
  } else {
    collectionTimer = setInterval(() => void collect().catch((e) => console.error(safeMarketError(e))), pollMs);
    publicationTimer = setInterval(() => void publish(), 1000); await publish();
  }
} catch (error) { await shutdown(); throw new Error(safeMarketError(error)); }
