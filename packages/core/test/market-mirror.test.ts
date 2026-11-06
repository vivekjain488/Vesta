import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSnapshot, validateCandles, contentHash, type MarketSnapshot } from "../../../arkiv/src/market-data";
import { MarketPublisher } from "../../../arkiv/src/market-publisher";
import { decodeMarketRow, writeValues, type MarketWrite } from "../../../arkiv/src/market-store";
const paths: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }); });
const now = 1793936500000;
const snapshot = (): MarketSnapshot => ({ version: 1, venue: "binance-usdm", marketType: "perpetual", symbol: "BTCUSDT", observedAtMs: now, sourceAtMs: now - 100, markPrice: "75000", indexPrice: "75010", fundingRate: "-0.0001", nextFundingAtMs: now + 1000000, openInterest: "12000", openInterestAtMs: now - 200, book: { updateId: "123", atMs: now - 10, bids: [["74999", "1"], ["74998", "2"]], asks: [["75001", "1"], ["75002", "2"]] }, provenance: { source: "https://fapi.binance.com", endpoints: ["/fapi/v1/depth"] } });
const item = (kind: "latest" | "snapshot" = "latest", uid: string = kind): Extract<MarketWrite, { kind: "latest" | "snapshot" }> => ({ uid, kind, bucketAtMs: now, data: snapshot() });
const hash = `0x${"ab".repeat(32)}` as const;
const key = `0x${"cd".repeat(32)}` as const;
function setup(overrides: any = {}) {
 vi.useFakeTimers(); vi.setSystemTime(now);
 const dir = mkdtempSync(join(tmpdir(), "market-mirror-")); paths.push(dir);
 const cfg = { privateKey: `0x${"11".repeat(32)}` as `0x${string}`, file: join(dir, "state.json"), maxPending: 3, retentionDays: 7, minimumBalanceWei: 1n };
 const deps = { find: async () => undefined, pub: { getBalance: async () => 100n, waitForTransactionReceipt: async () => ({ status: "success" }) } as any, client: { executeBatch: async (batch: any) => ({ txHash: hash, createdEntities: batch.creates.map(() => key) }) }, ...overrides };
 return { cfg, deps, publisher: new MarketPublisher(cfg, deps) };
}
describe("market data integrity", () => {
 it("accepts negative funding but rejects crossed books, stale components and future observations", () => {
  expect(validateSnapshot(snapshot(), now).fundingRate).toBe("-0.0001");
  const crossed = snapshot(); crossed.book.bids[0][0] = "75003"; expect(() => validateSnapshot(crossed, now)).toThrow();
  const stale = snapshot(); stale.openInterestAtMs = now - 60000; expect(() => validateSnapshot(stale, now)).toThrow("stale");
  const future = snapshot(); future.sourceAtMs = now + 20000; expect(() => validateSnapshot(future, now)).toThrow("future");
 });
 it("keeps only closed contiguous candles and verifies compressed payload hashes", () => {
  const t = Math.floor(now / 14400000) * 14400 - 14400;
  const window = { version: 1 as const, venue: "binance-usdm" as const, symbol: "BTCUSDT", interval: "4h" as const, observedAtMs: now, lastClosedAtMs: (t + 14400) * 1000 - 1, source: "https://fapi.binance.com", bars: [{ t, o: 1, h: 3, l: 1, c: 2, v: 1 }] };
  expect(validateCandles(window, now)).toEqual(window);
  expect(() => validateCandles({ ...window, bars: [{ ...window.bars[0], t: t + 14400 }] }, now)).toThrow("unclosed");
  const row = writeValues({ uid: "bars", kind: "candles", data: window }, now);
  expect(decodeMarketRow(row, true)).toEqual(window);
  expect(() => decodeMarketRow({ ...row, content_hash: "wrong" }, true)).toThrow("hash mismatch");
 });
});
describe("durable market publication", () => {
 it("bounds the queue, preserves latest state and restores pending data after a restart", () => {
  const { publisher, cfg, deps } = setup(); publisher.enqueue([item(), item("snapshot", "a"), item("snapshot", "b"), item("snapshot", "c")]);
  expect(publisher.pending).toBe(3); expect(publisher.dropped).toBe(1);
  const recovered = new MarketPublisher(cfg, deps); expect(recovered.pending).toBe(3); expect(recovered.dropped).toBe(1);
  expect(JSON.parse(readFileSync(cfg.file, "utf8")).queue.some((q: any) => q.kind === "latest")).toBe(true);
 });
 it("retains data after a failed write and acknowledges only confirmed publication", async () => {
  let fail = true; const { publisher } = setup({ client: { executeBatch: async () => { if (fail) throw Error("RPC unavailable"); return { txHash: hash, createdEntities: [key] }; } } });
  publisher.enqueue([item()]); await expect(publisher.flush()).rejects.toThrow("RPC unavailable"); expect(publisher.pending).toBe(1);
  fail = false; await publisher.flush(); expect(publisher.pending).toBe(0); expect(publisher.recentTransactions.at(-1)?.hash).toBe(hash);
 });
 it("does not drop a newer latest-state update arriving during a publication", async () => {
  let release: (x: any) => void = () => {}; let started: () => void = () => {};
  const entered = new Promise<void>((done) => { started = done; });
  const response = new Promise((done) => { release = done; });
  const { publisher, cfg } = setup({ client: { executeBatch: async () => { started(); return response; } } });
  publisher.enqueue([item()]); const writing = publisher.flush(); await entered;
  const updated = item(); updated.data.markPrice = "75005"; publisher.enqueue([updated]); release({ txHash: hash, createdEntities: [key] }); await writing;
  expect(publisher.pending).toBe(1); expect(JSON.parse(readFileSync(cfg.file, "utf8")).queue[0].data.markPrice).toBe("75005");
 });
 it("reconciles a persisted broadcast receipt without submitting that transaction twice", async () => {
  let calls = 0; const { cfg, deps } = setup({ find: async () => key, client: { executeBatch: async () => { calls++; throw Error("must not resend"); } } });
  const entry = item("snapshot"); writeFileSync(cfg.file, JSON.stringify({ queue: [entry], keys: {}, dropped: 0, inFlight: { hash, items: [entry] }, transactions: [] }));
  const recovered = new MarketPublisher(cfg, deps); await recovered.flush(); expect(calls).toBe(0); expect(recovered.pending).toBe(0);
 });
 it("does not publish stale latest quotes or treat low balance as successful publication", async () => {
  const { publisher, deps, cfg } = setup(); const old = item(); old.data.sourceAtMs -= 100000; publisher.enqueue([old]); await publisher.flush(); expect(publisher.recentTransactions).toHaveLength(0);
  const noFunds = new MarketPublisher({ ...cfg, file: cfg.file + "-empty" }, { ...deps, pub: { getBalance: async () => 0n } as any }); noFunds.enqueue([item()]); await expect(noFunds.flush()).rejects.toThrow("too little"); expect(noFunds.pending).toBe(1);
 });
});
